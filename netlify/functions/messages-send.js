// Sends an SMS via Telnyx using a template or raw body.
// DEDUPE-SAFE using provider_message_id (pass it!)
// Accepts: { to?, contact_id?, lead_id?, body?, templateKey?, requesterId?, provider_message_id? }

const { getServiceClient } = require("./_supabase");

// ---- Config / helpers ----
const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const DEFAULT_FROM_NUMBER = process.env.DEFAULT_FROM_NUMBER || process.env.TELNYX_FROM || null; // E.164
const MESSAGING_PROFILE_ID = process.env.TELNYX_MESSAGING_PROFILE_ID || null;

function json(obj, statusCode = 200) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
const S = (x) => (x == null ? "" : String(x));
const onlyDigits = (s) => String(s || "").replace(/\D/g, "");
const norm10 = (p) => onlyDigits(p).slice(-10);
function toE164(p) {
  const d = onlyDigits(p);
  if (!d) return null;
  if (d.startsWith("1") && d.length === 11) return `+${d}`;
  if (d.length === 10) return `+1${d}`;
  if (String(p || "").startsWith("+")) return String(p);
  return null;
}

// tiny mustache: {{ token }}
function renderTemplate(tpl, ctx) {
  if (!tpl) return "";
  return String(tpl).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => {
    const v = ctx && Object.prototype.hasOwnProperty.call(ctx, k) ? ctx[k] : "";
    return v == null ? "" : String(v);
  }).trim();
}

async function getUserFromLead(db, lead_id) {
  const { data, error } = await db
    .from("leads")
    .select("id, user_id, name, phone, email, state, beneficiary, beneficiary_name, military_branch")
    .eq("id", lead_id)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function getContact(db, user_id, contact_id) {
  const { data, error } = await db
    .from("message_contacts")
    .select("id, user_id, phone, full_name, tags, subscribed, created_at")
    .eq("user_id", user_id)
    .eq("id", contact_id)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function findContactByPhone(db, user_id, phoneLike) {
  const d10 = norm10(phoneLike);
  const { data, error } = await db
    .from("message_contacts")
    .select("id, user_id, phone, full_name, tags, subscribed, created_at")
    .eq("user_id", user_id);
  if (error) throw error;
  return (data || []).find((c) => norm10(c.phone) === d10) || null;
}

async function getAgentProfile(db, user_id) {
  const { data, error } = await db
    .from("agent_profiles")
    .select("user_id, name, company, phone, email, calendly_link")
    .eq("user_id", user_id)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function getTemplatesRow(db, user_id) {
  const { data, error } = await db
    .from("message_templates")
    .select("*")
    .eq("user_id", user_id)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function pickFromNumber(db, user_id) {
  // Prefer agent_profiles.phone → must be E.164
  const ap = await getAgentProfile(db, user_id);
  if (ap?.phone) return toE164(ap.phone) || DEFAULT_FROM_NUMBER;
  return DEFAULT_FROM_NUMBER;
}

// ---- Telnyx send ----
async function telnyxSend({ from, to, text, profileId }) {
  if (!TELNYX_API_KEY) throw new Error("TELNYX_API_KEY missing");
  const payload = {
    to,
    text,
    ...(profileId ? { messaging_profile_id: profileId } : {}),
    ...(from ? { from } : {}), // if your account requires a specific from, keep this
  };
  const res = await fetch("https://api.telnyx.com/v2/messages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TELNYX_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = out?.errors?.[0]?.detail || JSON.stringify(out);
    const err = new Error(`Telnyx send failed: ${detail}`);
    err.telnyx_response = out;
    throw err;
  }
  return out; // contains data.id, etc.
}

exports.handler = async (event) => {
  const trace = [];
  const db = getServiceClient();

  try {
    let body;
    try { body = JSON.parse(event.body || "{}"); }
    catch { return json({ error: "invalid_json" }, 400); }

    let {
      to,
      contact_id,
      lead_id,
      body: rawBody,
      templateKey,            // e.g. "new_lead", "new_lead_military", "follow_up_2d"
      requesterId,            // optional (UI passes it on manual send)
      provider_message_id,    // IMPORTANT for dedupe
    } = body || {};

    // -------- Resolve user_id, contact, destination phone --------
    // Priority: lead_id → user_id + phone, else contact_id → user_id + phone, else requesterId + to
    let user_id = null;
    let contact = null;
    let lead = null;

    if (lead_id) {
      lead = await getUserFromLead(db, lead_id);
      if (!lead) return json({ error: "lead_not_found", lead_id }, 404);
      user_id = lead.user_id;
      // If 'to' not given, use lead.phone
      to = to || lead.phone;
    }

    if (!user_id && requesterId) user_id = requesterId;

    if (contact_id) {
      // if user_id not known yet, we need it to read the contact
      if (!user_id) {
        const { data: cRow, error } = await db
          .from("message_contacts")
          .select("user_id")
          .eq("id", contact_id)
          .maybeSingle();
        if (error) throw error;
        user_id = cRow?.user_id || user_id;
      }
      contact = await getContact(db, user_id, contact_id);
      if (!contact) return json({ error: "contact_not_found", contact_id }, 404);
      to = to || contact.phone;
    }

    if (!user_id) {
      return json({ error: "missing_user_context", hint: "provide lead_id, contact_id, or requesterId" }, 400);
    }

    const toE = toE164(to);
    if (!toE) return json({ error: "invalid_destination", to }, 400);

    // If contact missing, try to find it by phone for this user (so message joins a contact thread)
    if (!contact) contact = await findContactByPhone(db, user_id, toE);

    // ---- Wallet gate (optional but recommended) ----
    // If this is a fully automated send, your UI guard may not apply—so keep this server-side too.
    try {
      const { data: wal } = await db
        .from("user_wallets")
        .select("balance_cents")
        .eq("user_id", user_id)
        .maybeSingle();
      if (wal && (wal.balance_cents || 0) <= 0 && !rawBody /* automated */) {
        return json({ error: "insufficient_balance", trace }, 402);
      }
    } catch {}

    // -------- DEDUPE: provider_message_id guard --------
    if (provider_message_id) {
      const { data: dupe, error: dErr } = await db
        .from("messages")
        .select("id, provider_sid, created_at")
        .eq("user_id", user_id)
        .eq("provider_message_id", provider_message_id)
        .limit(1);
      if (dErr) throw dErr;
      if (dupe && dupe.length) {
        trace.push({ step: "dedupe.hit", provider_message_id });
        return json({ ok: true, deduped: true, provider_message_id, trace });
      }
    }

    // -------- Build message body (template or raw) --------
    let bodyText = String(rawBody || "").trim();

    if (!bodyText) {
      // Load templates row
      const mt = await getTemplatesRow(db, user_id);
      if (!mt) return json({ error: "template_not_configured" }, 400);

      // enabled flag(s)
      // supports either a boolean .enabled or shape .enabled[key]
      const enabledGlobal = typeof mt.enabled === "boolean" ? mt.enabled : true;
      const enabledByKey   = typeof mt.enabled === "object" && mt.enabled !== null ? mt.enabled[templateKey] : undefined;
      const isEnabled = enabledGlobal && (enabledByKey !== false);

      if (!isEnabled) {
        return json({ status: "skipped_disabled", templateKey, trace });
      }

      // pick template string (supports legacy columns or nested mt.templates)
      const T = (k) => (mt.templates?.[k] ?? mt[k] ?? "");
      let tpl = "";
      if (templateKey) {
        tpl = String(T(templateKey) || "").trim();
      }
      if (!tpl) {
        return json({ error: "template_not_found", templateKey }, 404);
      }

      // Build context
      const ap = await getAgentProfile(db, user_id);
      const ctx = {
        // lead/contact fields
        first_name: "", last_name: "", full_name: "",
        state: "", beneficiary: "", military_branch: "",
        // agent fields
        agent_name: ap?.name || "",
        company: ap?.company || "",
        agent_phone: ap?.phone || "",
        agent_email: ap?.email || "",
        calendly_link: ap?.calendly_link || "",
      };

      // Try to populate name & fields from lead or contact
      const fullName =
        (lead?.name) ||
        (contact?.full_name) ||
        "";

      if (fullName) {
        ctx.full_name = fullName;
        const parts = fullName.split(/\s+/).filter(Boolean);
        ctx.first_name = parts[0] || "";
        ctx.last_name  = parts.slice(1).join(" ");
      }
      ctx.state = lead?.state || "";
      ctx.beneficiary = lead?.beneficiary || lead?.beneficiary_name || "";
      ctx.military_branch = lead?.military_branch || (
        (Array.isArray(contact?.tags) && contact.tags.includes("military")) ? "Military" : ""
      );

      bodyText = renderTemplate(tpl, ctx);
      if (!bodyText) return json({ error: "rendered_empty_body" }, 400);
    }

    // -------- Determine FROM number --------
    const fromE164 = await pickFromNumber(db, user_id);
    if (!fromE164) return json({ error: "no_from_number_configured" }, 400);

    // -------- Send via Telnyx --------
    let telnyxResp;
    try {
      telnyxResp = await telnyxSend({
        from: fromE164,
        to: toE,
        text: bodyText,
        profileId: MESSAGING_PROFILE_ID,
      });
      trace.push({ step: "telnyx.sent", id: telnyxResp?.data?.id });
    } catch (e) {
      trace.push({ step: "telnyx.error", detail: e?.message || String(e) });
      return json({ error: "send_failed", detail: e?.message || String(e), telnyx_response: e?.telnyx_response, trace }, 502);
    }

    const provider_sid = telnyxResp?.data?.id || null;

    // -------- Insert message row --------
    const row = {
      user_id,
      contact_id: contact?.id || null,
      direction: "outgoing",
      provider: "telnyx",
      from_number: fromE164,
      to_number: toE,
      body: bodyText,
      status: "sent",
      provider_sid,
      // DEDUPE KEY stored on the row:
      provider_message_id: provider_message_id || null,
      price_cents: 0, // (optional) fill in if you rate/charge per message
      // For traceability:
      meta: {
        templateKey: templateKey || null,
        lead_id: lead?.id || (lead_id || null),
      },
    };

    const ins = await db.from("messages").insert([row]).select("id, contact_id").maybeSingle();
    if (ins?.error) {
      // If insert fails due to unique(provider_message_id), we’re deduped anyway
      if ((ins.error.message || "").toLowerCase().includes("duplicate")) {
        trace.push({ step: "insert.duplicate", provider_message_id });
        return json({ ok: true, deduped: true, provider_message_id, trace });
      }
      return json({ error: "db_insert_failed", detail: ins.error.message, trace }, 500);
    }

    // Success
    return json({
      ok: true,
      id: ins?.data?.id || null,
      provider_sid,
      provider_message_id: provider_message_id || null,
      contact_id: ins?.data?.contact_id || contact?.id || null,
      trace,
    });
  } catch (e) {
    return json({ error: "unhandled", detail: String(e?.message || e) });
  }
};