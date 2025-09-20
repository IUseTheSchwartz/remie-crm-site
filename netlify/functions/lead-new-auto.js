// File: netlify/functions/lead-new-auto.js
// Auto-send "new lead" text. Picks military vs normal by BOTH lead.military_branch
// and the contact's tags (normalized). Still sends if contact row isn't found yet.

const { getServiceClient } = require("./_supabase");

function json(obj, statusCode = 200) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
const S = (x) => (x == null ? "" : String(x).trim());
const norm10 = (p) => String(p || "").replace(/\D/g, "").slice(-10);
const toE164 = (p) => {
  const d = String(p || "").replace(/\D/g, "");
  if (!d) return null;
  if (d.startsWith("1") && d.length === 11) return `+${d}`;
  if (d.length === 10) return `+1${d}`;
  if (String(p).startsWith("+")) return String(p);
  return null;
};

exports.handler = async (event) => {
  const trace = [];
  try {
    const db = getServiceClient();

    let body;
    try { body = JSON.parse(event.body || "{}"); }
    catch { return json({ error: "invalid_json", trace }, 400); }

    const { lead_id } = body || {};
    if (!lead_id) return json({ error: "missing_lead_id", trace }, 400);

    // 1) Load the lead (include military_branch!)
    const { data: lead, error: lerr } = await db
      .from("leads")
      .select("id,user_id,name,phone,state,beneficiary,beneficiary_name,military_branch")
      .eq("id", lead_id)
      .maybeSingle();
    if (lerr) return json({ error: "lead_lookup_failed", detail: lerr.message, trace }, 500);
    if (!lead) return json({ error: "lead_not_found", lead_id, trace }, 404);
    trace.push({ step: "lead.loaded", lead_id: lead.id, user_id: lead.user_id });

    const to = toE164(lead.phone || "");
    if (!to) return json({ error: "invalid_or_missing_lead_phone", trace }, 400);

    // 2) Try to find the contact (but don't hard-fail if missing)
    let contact = null;
    try {
      const { data: contacts, error: cerr } = await db
        .from("message_contacts")
        .select("id,phone,subscribed,tags")
        .eq("user_id", lead.user_id);
      if (cerr) trace.push({ warn: "contact_list_failed", detail: cerr.message });
      contact = (contacts || []).find((c) => norm10(c.phone) === norm10(lead.phone)) || null;
    } catch (e) {
      trace.push({ warn: "contact_lookup_exception", detail: String(e?.message || e) });
    }

    if (contact && contact.subscribed === false) {
      return json({ error: "contact_unsubscribed", contact_id: contact.id, trace }, 400);
    }
    if (contact) trace.push({ step: "contact.matched", contact_id: contact.id, tags: contact.tags || [] });
    else trace.push({ step: "contact.not_found_proceeding" });

    // 3) Decide template: military if (lead.military_branch present) OR (contact has 'military' tag)
    const tagsNorm = (contact?.tags || []).map((t) => String(t || "").trim().toLowerCase());
    const hasMilitaryTag = tagsNorm.includes("military");
    const hasMilitaryField = !!S(lead.military_branch);
    const isMilitary = hasMilitaryField || hasMilitaryTag;
    const templateKey = isMilitary ? "new_lead_military" : "new_lead";
    const provider_message_id = `auto_${templateKey}_${lead.id}`;
    trace.push({ step: "template.choose", templateKey, hasMilitaryField, hasMilitaryTag });

    // 4) Build base URL to call messages-send
    const proto = event.headers["x-forwarded-proto"] || "https";
    const host = event.headers.host || (process.env.URL || process.env.SITE_URL || "").replace(/^https?:\/\//, "");
    const base = process.env.SITE_URL || (proto && host ? `${proto}://${host}` : null);
    if (!base) return json({ error: "no_base_url", trace }, 500);

    // 5) Call messages-send. It will resolve the body from message_templates.
    const res = await fetch(`${base}/.netlify/functions/messages-send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lead_id,
        templateKey,
        provider_message_id,
        // (requesterId optional; messages-send can infer from lead_id)
      }),
    });

    const text = await res.text();
    let inner = null; try { inner = JSON.parse(text); } catch {}
    trace.push({ step: "messages-send.invoked", status: res.status });

    return json({
      ok: !!inner?.ok,
      lead_id,
      contact_id: contact?.id || null,
      send_status: res.status,
      send: inner,   // includes messages-send trace
      trace,
    }, res.ok ? 200 : 207);

  } catch (e) {
    return json({ error: "unhandled", detail: String(e?.message || e), trace }, 500);
  }
};