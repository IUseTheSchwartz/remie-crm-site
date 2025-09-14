// File: netlify/functions/lead-new-auto.js
// Thin wrapper: choose template by tag and call messages-send.
// Returns messages-send's result embedded (with its full trace).

const { getServiceClient } = require("./_supabase");

function json(obj, statusCode = 200) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
const norm10 = (p) => String(p || "").replace(/\D/g, "").slice(-10);

exports.handler = async (event) => {
  const trace = [];
  try {
    const db = getServiceClient();

    let body;
    try { body = JSON.parse(event.body || "{}"); }
    catch { return json({ error: "invalid_json", trace }, 400); }

    const { lead_id } = body || {};
    if (!lead_id) return json({ error: "missing_lead_id", trace }, 400);

    // Load lead
    const { data: lead, error: lerr } = await db
      .from("leads")
      .select("id,user_id,name,phone,state,beneficiary,beneficiary_name")
      .eq("id", lead_id)
      .maybeSingle();
    if (lerr) return json({ error: "lead_lookup_failed", detail: lerr.message, trace }, 500);
    if (!lead) return json({ error: "lead_not_found", lead_id, trace }, 404);
    trace.push({ step: "lead.loaded", lead_id: lead.id, user_id: lead.user_id });

    // Find the contact created for this lead (you said this is already working)
    const { data: contacts, error: cerr } = await db
      .from("message_contacts")
      .select("id,phone,subscribed,tags")
      .eq("user_id", lead.user_id);
    if (cerr) return json({ error: "contact_list_failed", detail: cerr.message, trace }, 500);

    const contact = (contacts || []).find((c) => norm10(c.phone) === norm10(lead.phone)) || null;
    if (!contact) return json({ error: "contact_not_found_for_lead_phone", trace }, 404);
    if (!contact.subscribed) return json({ error: "contact_unsubscribed", contact_id: contact.id, trace }, 400);
    trace.push({ step: "contact.matched", contact_id: contact.id, tags: contact.tags || [] });

    // Choose template by tag (⚠️ use your key exactly)
    const hasMilitary = (contact.tags || []).includes("military");
    const templateKey = hasMilitary ? "new_lead_military" : "new_lead";
    const provider_message_id = `auto_${templateKey}_${lead.id}`;
    trace.push({ step: "template.choose", templateKey, provider_message_id });

    // Build base URL for invoking sibling function
    const proto = event.headers["x-forwarded-proto"] || "https";
    const host = event.headers.host || process.env.URL?.replace(/^https?:\/\//, "");
    const base = process.env.SITE_URL || (proto && host ? `${proto}://${host}` : null);
    if (!base) return json({ error: "no_base_url", trace }, 500);

    // Call messages-send (it returns a full trace always)
    const res = await fetch(`${base}/.netlify/functions/messages-send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lead_id, templateKey, provider_message_id }),
    });

    const text = await res.text();
    let inner = null; try { inner = JSON.parse(text); } catch {}
    trace.push({ step: "messages-send.invoked", status: res.status });

    return json({
      ok: !!inner?.ok,
      lead_id,
      contact_id: contact.id,
      send_status: res.status,
      send: inner,       // includes messages-send trace
      trace,
    }, res.ok ? 200 : 207);

  } catch (e) {
    return json({ error: "unhandled", detail: String(e?.message || e), trace }, 500);
  }
};
