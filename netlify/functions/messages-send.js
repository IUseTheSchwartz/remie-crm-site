// File: netlify/functions/messages-send.js
// Outbound SMS send (Telnyx-only).
// - Inserts into public.messages with status='sent' once Telnyx accepts the message
// - Lets a DB trigger (wallet_debit_on_message) debit 1¢ per row
// - Dedupe via provider_message_id
// - Returns a helpful 'trace' array

const { getServiceClient } = require("./_supabase");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE =
  process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY;

const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const TELNYX_MESSAGING_PROFILE_ID = process.env.TELNYX_MESSAGING_PROFILE_ID;
const TELNYX_FROM_NUMBER = process.env.TELNYX_FROM_NUMBER;

function json(obj, statusCode = 200) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  };
}

function normalizeUS(phone) {
  const d = String(phone || "").replace(/\D/g, "");
  if (!d) return null;
  if (d.startsWith("1") && d.length === 11) return `+${d}`;
  if (d.length === 10) return `+1${d}`;
  if (String(phone).startsWith("+")) return phone;
  return null;
}
const norm10 = (p) => String(p || "").replace(/\D/g, "").slice(-10);
const mask = (p = "") => {
  const d = String(p).replace(/\D/g, "");
  return d ? `***${d.slice(-4)}` : "***";
};

function renderTemplate(raw, vars) {
  return String(raw || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, k) => (vars?.[k] ?? ""));
}

async function fetchTemplatesRow(db, user_id) {
  const { data, error } = await db
    .from("message_templates")
    .select("templates, enabled")
    .eq("user_id", user_id)
    .maybeSingle();
  if (error) throw error;
  return { templates: data?.templates || {}, enabled: data?.enabled || {} };
}

async function fetchAgent(db, user_id) {
  const { data, error } = await db
    .from("agent_profiles")
    .select("full_name, phone, calendly_url")
    .eq("user_id", user_id)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function lookupContactByPhone(db, user_id, toRaw) {
  const last10 = norm10(toRaw);
  const { data, error } = await db
    .from("message_contacts")
    .select("id,user_id,full_name,phone,subscribed,tags,meta")
    .eq("user_id", user_id);
  if (error) throw error;
  return (data || []).find((c) => norm10(c.phone) === last10) || null;
}

exports.handler = async (evt) => {
  const trace = [];

  try {
    // Env check
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE)
      return json({ error: "server_misconfigured", missing: "SUPABASE_URL/SUPABASE_SERVICE_ROLE", trace }, 500);
    if (!TELNYX_API_KEY || !TELNYX_FROM_NUMBER)
      return json({ error: "server_misconfigured", missing: "TELNYX_API_KEY/TELNYX_FROM_NUMBER", trace }, 500);

    // Parse
    let body;
    try { body = JSON.parse(evt.body || "{}"); }
    catch { return json({ error: "invalid_json", trace }, 400); }

    let { user_id, to: toRaw, templateKey, provider_message_id, contact_id, lead_id } = body;
    const placeholdersIn = body.placeholders || {};
    const db = getServiceClient();

    trace.push({ step: "input", user_id: !!user_id, to: !!toRaw, templateKey, contact_id, lead_id });

    // Hydrate lead/contact if provided
    let lead = null;
    let contact = null;

    if (lead_id) {
      const { data: l, error: lerr } = await db
        .from("leads")
        .select("id,user_id,name,phone,state,beneficiary,beneficiary_name,status,sold,military_branch")
        .eq("id", lead_id)
        .maybeSingle();
      if (lerr) return json({ error: "lead_lookup_failed", detail: lerr.message, trace }, 500);
      if (!l) return json({ error: "lead_not_found", lead_id, trace }, 404);
      lead = l; user_id = user_id || l.user_id; toRaw = toRaw || l.phone;
      trace.push({ step: "lead.hydrated", lead_id: lead.id, user_id: lead.user_id, toMasked: mask(toRaw) });
    }

    if (contact_id) {
      const { data: c, error: cerr } = await db
        .from("message_contacts")
        .select("id,user_id,full_name,phone,subscribed,tags,meta")
        .eq("id", contact_id)
        .maybeSingle();
      if (cerr) return json({ error: "contact_lookup_failed", detail: cerr.message, trace }, 500);
      if (!c) return json({ error: "contact_not_found", contact_id, trace }, 404);
      contact = c; user_id = user_id || c.user_id; toRaw = toRaw || c.phone;
      trace.push({ step: "contact.hydrated", contact_id: contact.id, toMasked: mask(toRaw) });
    }

    // Requirements
    if (!templateKey || (!user_id && !lead_id && !contact_id) || (!toRaw && !lead_id && !contact_id)) {
      return json({
        error: "missing_fields",
        need: ["templateKey", "and one of: (user_id + to) or (contact_id) or (lead_id)"],
        got: { user_id: !!user_id, templateKey: !!templateKey, to: !!toRaw, contact_id: !!contact_id, lead_id: !!lead_id },
        trace
      }, 400);
    }

    if (!contact && toRaw && user_id) contact = await lookupContactByPhone(db, user_id, toRaw);

    // Normalize phone
    const to = normalizeUS(toRaw);
    if (!to) return json({ error: "invalid_phone", toRaw, trace }, 400);

    // Respect unsubscribe if we found a contact row
    if (contact && contact.subscribed === false) {
      trace.push({ step: "gate.subscribed=false", contact_id: contact.id });
      return json({ status: "skipped_unsubscribed", contact_id: contact.id, trace }, 200);
    }

    // Templates + enabled
    const { templates, enabled } = await fetchTemplatesRow(db, user_id);
    const templateEnabled = enabled?.[templateKey] === true;
    const templateRaw = templates?.[templateKey];

    trace.push({ step: "templates.loaded", templateKey, enabled: !!templateEnabled, hasTemplate: !!templateRaw });

    if (!templateEnabled) return json({ status: "skipped_disabled", templateKey, trace }, 200);
    if (!templateRaw)   return json({ error: "template_not_found", templateKey, trace }, 404);

    // Agent + placeholders
    const agent = await fetchAgent(db, user_id);
    const leadSold = lead?.sold || {};
    const first_name =
      placeholdersIn.first_name ||
      (contact?.full_name || lead?.name || "").split(/\s+/)[0] || "";

    const vars = {
      first_name,
      state: placeholdersIn.state || lead?.state || contact?.meta?.state || "",
      beneficiary: placeholdersIn.beneficiary || lead?.beneficiary_name || lead?.beneficiary || contact?.meta?.beneficiary || "",
      agent_name: placeholdersIn.agent_name || agent?.full_name || "",
      agent_phone: placeholdersIn.agent_phone || agent?.phone || "",
      calendly_link: placeholdersIn.calendly_link || agent?.calendly_url || "",
      carrier: placeholdersIn.carrier || leadSold.carrier || "",
      policy_number: placeholdersIn.policy_number || leadSold.policy_number || "",
      premium: placeholdersIn.premium || leadSold.premium || "",
      monthly_payment: placeholdersIn.monthly_payment || leadSold.monthly_payment || "",
      policy_start_date: placeholdersIn.policy_start_date || leadSold.policy_start_date || "",
      face_amount: placeholdersIn.face_amount || leadSold.face_amount || "",
      military_branch: placeholdersIn.military_branch || lead?.military_branch || contact?.meta?.military_branch || "",
    };

    const text = renderTemplate(templateRaw, vars).trim();
    if (!text) return json({ error: "rendered_empty_body", templateKey, vars, trace }, 400);

    // Dedupe key
    if (!provider_message_id) {
      provider_message_id = `auto_${templateKey}_${lead_id || contact_id || norm10(to)}`;
    }

    // Dedupe check
    const { data: dupeRows, error: dupErr } = await db
      .from("messages")
      .select("id")
      .eq("user_id", user_id)
      .eq("provider_message_id", provider_message_id)
      .limit(1);
    if (!dupErr && dupeRows?.length) {
      return json({ ok: true, deduped: true, provider_message_id, trace }, 200);
    }

    // Telnyx send
    const reqPayload = {
      from: TELNYX_FROM_NUMBER,
      to,
      text,
      ...(TELNYX_MESSAGING_PROFILE_ID ? { messaging_profile_id: TELNYX_MESSAGING_PROFILE_ID } : {}),
    };
    trace.push({ step: "telnyx.request", toMasked: mask(to), from: TELNYX_FROM_NUMBER, withProfile: !!TELNYX_MESSAGING_PROFILE_ID });

    let provider_id = null;
    try {
      const resp = await fetch("https://api.telnyx.com/v2/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${TELNYX_API_KEY}` },
        body: JSON.stringify(reqPayload),
      });
      const out = await resp.json().catch(() => ({}));
      trace.push({ step: "telnyx.response", ok: resp.ok, status: resp.status, body: out });

      if (!resp.ok) {
        return json({ error: "provider_send_failed", trace, telnyx: { status: resp.status, error_detail: out } }, 502);
      }
      provider_id = out?.data?.id || out?.id || null;
    } catch (e) {
      return json({ error: "provider_network_error", detail: e?.message, trace }, 502);
    }

    // Insert message row (status = 'sent' right away; debit via DB trigger)
    const insertRow = {
      user_id,
      contact_id: contact?.id || null,
      lead_id: lead?.id || null,
      direction: "outgoing",
      provider: "telnyx",
      from_number: TELNYX_FROM_NUMBER,
      to_number: to,
      body: text,
      status: "sent",               // was 'queued' — we mark as sent once provider accepts
      provider_sid: provider_id,
      provider_message_id,
      price_cents: 1,               // DB trigger will subtract this from wallet
    };

    const { data: ins, error: insErr } = await db
      .from("messages")
      .insert([insertRow])
      .select("id")
      .maybeSingle();

    if (insErr) return json({ error: "db_insert_failed", detail: insErr.message, trace }, 500);

    trace.push({ step: "wallet.debit.via_trigger" });

    return json({
      ok: true,
      message_id: ins?.id || null,
      provider_sid: provider_id,
      provider_message_id,
      trace,
    });
  } catch (e) {
    return json({ error: "unhandled_server_error", detail: String(e?.message || e), trace }, 500);
  }
};
