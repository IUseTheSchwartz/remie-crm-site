// File: netlify/functions/messages-send.js
// Sends SMS via Telnyx. Works in two modes:
//  1) Direct send:   { to, body, requesterId? }
//  2) Template send: { lead_id, templateKey, requesterId? }  -> renders body & resolves "to"
// Also: duplicate protection (no schema changes needed) + STOP guard.

const fetch = require("node-fetch");
const { getServiceClient } = require("./_supabase");

/* --------------------------------- Helpers --------------------------------- */

function json(obj, statusCode = 200) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  };
}

const S = (x) => (x == null ? "" : String(x));

function toE164(p) {
  const d = S(p).replace(/\D/g, "");
  if (!d) return null;
  if (d.startsWith("1") && d.length === 11) return `+${d}`;
  if (d.length === 10) return `+1${d}`;
  if (S(p).startsWith("+")) return S(p);
  return null;
}
const norm10 = (p) => S(p).replace(/\D/g, "").slice(-10);

function renderTemplate(tpl, map) {
  const merged = {
    full_name:
      map.full_name ||
      [map.first_name, map.last_name].filter(Boolean).join(" ").trim(),
    ...map,
  };
  return S(tpl).replace(/{{\s*([\w.]+)\s*}}/g, (_, k) =>
    merged[k] == null ? "" : String(merged[k])
  );
}

async function resolveFromNumber(db, user_id) {
  // A) most recent from_number used by this user
  const { data: m } = await db
    .from("messages")
    .select("from_number")
    .eq("user_id", user_id)
    .neq("from_number", null)
    .order("created_at", { ascending: false })
    .limit(1);
  if (m && m[0]?.from_number) return m[0].from_number;

  // B) agent profile phone
  const ap = await db
    .from("agent_profiles")
    .select("phone")
    .eq("user_id", user_id)
    .maybeSingle();
  if (ap?.data?.phone) return ap.data.phone;

  // C) env default
  return process.env.DEFAULT_FROM_NUMBER || null;
}

// Dedupe window (minutes). Prevents double-sends of the *same body* to the *same number*.
// No schema changes required.
const DEDUPE_MINUTES = Number(process.env.SEND_DEDUPE_MINUTES || 10);

async function alreadySentRecently(db, { user_id, to, body }) {
  try {
    const sinceISO = new Date(Date.now() - DEDUPE_MINUTES * 60 * 1000).toISOString();
    const { data, error } = await db
      .from("messages")
      .select("id, to_number, body, created_at, status")
      .eq("user_id", user_id)
      .eq("to_number", to)
      .gte("created_at", sinceISO)
      .in("status", ["queued", "sent"])
      .order("created_at", { ascending: false })
      .limit(10);
    if (error) return false;
    return (data || []).some((m) => S(m.body).trim() === S(body).trim());
  } catch {
    return false;
  }
}

/* ---------------------------------- Main ----------------------------------- */

exports.handler = async (event) => {
  const trace = [];
  try {
    const db = getServiceClient();

    // Parse payload
    let payload = {};
    try {
      payload = JSON.parse(event.body || "{}");
    } catch {
      return json({ error: "invalid_json", trace }, 400);
    }

    // Inputs
    let { to, body, requesterId, lead_id, templateKey, provider_message_id } = payload;
    to = to ? toE164(to) : null;
    body = S(body || "");

    // Mode validation
    if (!lead_id && !to) {
      return json(
        { error: "missing_destination", note: "Provide either lead_id or to", trace },
        400
      );
    }

    // Resolve user_id
    let user_id = requesterId || null;
    if (!user_id && lead_id) {
      const { data: L, error: Lerr } = await db
        .from("leads")
        .select("user_id")
        .eq("id", lead_id)
        .maybeSingle();
      if (Lerr) return json({ error: "lead_lookup_failed", detail: Lerr.message, trace }, 500);
      if (!L?.user_id) return json({ error: "no_user_for_lead", trace }, 400);
      user_id = L.user_id;
    }
    if (!user_id) return json({ error: "missing_user", trace }, 400);
    trace.push({ step: "user.resolved", user_id });

    /* --------------------------- TEMPLATE MODE (lead) --------------------------- */
    if (lead_id && templateKey) {
      // Load lead
      const { data: lead, error: lerr } = await db
        .from("leads")
        .select(
          "id, user_id, name, phone, state, beneficiary, beneficiary_name, military_branch"
        )
        .eq("id", lead_id)
        .maybeSingle();
      if (lerr) return json({ error: "lead_load_failed", detail: lerr.message, trace }, 500);
      if (!lead) return json({ error: "lead_not_found", lead_id, trace }, 404);

      // Resolve contact (STOP/subscribe + phone)
      const { data: contacts, error: cerr } = await db
        .from("message_contacts")
        .select("id, phone, full_name, subscribed, tags")
        .eq("user_id", user_id);
      if (cerr) return json({ error: "contacts_load_failed", detail: cerr.message, trace }, 500);

      const contact =
        (contacts || []).find((c) => norm10(c.phone) === norm10(lead.phone)) || null;
      if (!contact)
        return json({ error: "contact_not_found_for_lead", lead_id, trace }, 404);
      if (!contact.subscribed)
        return json(
          { error: "contact_unsubscribed", contact_id: contact.id, trace },
          400
        );

      to = toE164(contact.phone);
      if (!to) return json({ error: "invalid_contact_phone", trace }, 400);

      // Load message_templates for this user
      const { data: mt, error: terr } = await db
        .from("message_templates")
        .select("*")
        .eq("user_id", user_id)
        .maybeSingle();
      if (terr) return json({ error: "templates_load_failed", detail: terr.message, trace }, 500);
      if (!mt) return json({ error: "template_not_found", templateKey, trace }, 404);

      // Enabled (compat with boolean or per-key map)
      const enabled =
        typeof mt.enabled === "boolean" ? mt.enabled : (mt.enabled?.[templateKey] ?? true);
      if (!enabled) {
        trace.push({ step: "template.disabled", templateKey });
        return json({ status: "skipped_disabled", templateKey, trace }, 200);
      }

      // Resolve template string (support flat columns OR nested map)
      const tpl =
        mt.templates?.[templateKey] ??
        mt[templateKey] ??
        "";
      if (!S(tpl).trim())
        return json({ error: "template_body_empty", templateKey, trace }, 400);

      // Agent profile for variables
      const { data: ap } = await db
        .from("agent_profiles")
        .select("full_name, phone, email, company, calendly_link")
        .eq("user_id", user_id)
        .maybeSingle();

      const varMap = {
        first_name: (lead.name || "").split(" ")[0] || "",
        last_name:  (lead.name || "").split(" ").slice(1).join(" ") || "",
        full_name:  lead.name || contact.full_name || "",
        state:      lead.state || "",
        beneficiary: lead.beneficiary || lead.beneficiary_name || "",
        military_branch: lead.military_branch || "",
        agent_name: ap?.data?.full_name || "",
        agent_phone: ap?.data?.phone || "",
        agent_email: ap?.data?.email || "",
        company: ap?.data?.company || "",
        calendly_link: ap?.data?.calendly_link || "",
      };

      body = renderTemplate(tpl, varMap).trim();
      if (!body) return json({ error: "rendered_body_empty", templateKey, trace }, 400);

      trace.push({
        step: "template.rendered",
        templateKey,
        to,
        preview: body.slice(0, 120),
      });
    }

    /* --------------------------- DIRECT MODE (manual) -------------------------- */
    // If the UI calls with { to, body } (no lead_id), we still STOP-check if contact exists.
    if (to && !lead_id) {
      const { data: cList } = await db
        .from("message_contacts")
        .select("id, phone, subscribed")
        .eq("user_id", user_id);
      const hit =
        (cList || []).find((c) => norm10(c.phone) === norm10(to)) || null;
      if (hit && hit.subscribed === false) {
        return json({ error: "contact_unsubscribed", contact_id: hit.id, trace }, 400);
      }
    }

    // Final validation
    if (!to) return json({ error: "missing_to", trace }, 400);
    if (!body) return json({ error: "missing_body", trace }, 400);

    // Dedup same body to same number in recent window
    const dupe = await alreadySentRecently(db, { user_id, to, body });
    if (dupe) {
      trace.push({ step: "dedupe.hit", window_minutes: DEDUPE_MINUTES, to });
      return json({ ok: true, deduped: true, to, trace }, 200);
    }

    // Resolve FROM number
    const from_number = await resolveFromNumber(db, user_id);
    if (!from_number)
      return json({ error: "no_from_number_configured", trace }, 500);

    /* ------------------------ Insert "queued" DB message ------------------------ */
    const msgRow = {
      user_id,
      contact_id: null, // optional; you can populate if you want
      direction: "outgoing",
      provider: "telnyx",
      from_number,
      to_number: to,
      body,
      status: "queued",
      provider_sid: null,
      price_cents: 0,
    };

    const { data: ins, error: insErr } = await db
      .from("messages")
      .insert([msgRow])
      .select("id, created_at")
      .maybeSingle();

    if (insErr) {
      return json({ error: "db_insert_failed", detail: insErr.message, trace }, 500);
    }
    const message_id = ins?.id;
    trace.push({ step: "db.inserted", message_id });

    /* ------------------------------ Send via Telnyx ----------------------------- */
    const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
    const TELNYX_MESSAGING_PROFILE_ID = process.env.TELNYX_MESSAGING_PROFILE_ID;
    if (!TELNYX_API_KEY || !TELNYX_MESSAGING_PROFILE_ID) {
      await db.from("messages").update({ status: "failed" }).eq("id", message_id);
      return json({ error: "telnyx_not_configured", trace }, 500);
    }

    const tx = {
      from: from_number,
      to,
      text: body,
      messaging_profile_id: TELNYX_MESSAGING_PROFILE_ID,
      webhook_url: process.env.TELNYX_WEBHOOK_URL || undefined,
      // Helpful in Telnyx portal for correlating retries/ids; not used for DB dedupe
      subject: provider_message_id || undefined,
    };

    let telnyx_response = null;
    try {
      const res = await fetch("https://api.telnyx.com/v2/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TELNYX_API_KEY}`,
        },
        body: JSON.stringify(tx),
      });

      const txt = await res.text();
      try {
        telnyx_response = JSON.parse(txt);
      } catch {
        telnyx_response = { raw: txt };
      }

      if (!res.ok) {
        await db.from("messages").update({ status: "failed" }).eq("id", message_id);
        trace.push({ step: "telnyx.error", status: res.status, telnyx_response });
        return json(
          { error: "telnyx_send_failed", status: res.status, telnyx_response, trace },
          502
        );
      }
    } catch (e) {
      await db.from("messages").update({ status: "failed" }).eq("id", message_id);
      trace.push({ step: "telnyx.exception", detail: String(e?.message || e) });
      return json({ error: "telnyx_exception", detail: String(e?.message || e), trace }, 502);
    }

    const provider_sid =
      telnyx_response?.data?.id ||
      telnyx_response?.data?.record_type ||
      null;

    // Mark sent
    await db
      .from("messages")
      .update({ status: "sent", provider_sid })
      .eq("id", message_id);

    trace.push({ step: "db.updated.sent", message_id, provider_sid });

    return json({
      ok: true,
      message_id,
      provider_sid,
      telnyx_response,
      trace,
    });
  } catch (e) {
    return json({ error: "unhandled", detail: String(e?.message || e), trace }, 500);
  }
};