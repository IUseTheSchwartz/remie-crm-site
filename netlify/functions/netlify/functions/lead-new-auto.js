// netlify/functions/lead-new-auto.js
const { getServiceClient } = require("./_supabase.js");

const supabase = getServiceClient();

function json(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

function S(x) { return (x == null ? "" : String(x)).trim(); }

// naive {{var}} -> value
function render(tpl, ctx) {
  return String(tpl || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, k) => S(ctx[k]));
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  let p = {};
  try { p = JSON.parse(event.body || "{}"); } catch { return json(400, { error: "Invalid JSON" }); }

  const { lead_id, requesterId } = p || {};
  if (!lead_id || !requesterId) return json(400, { error: "Missing lead_id or requesterId" });

  // 1) Load the lead (must belong to requester)
  const { data: lead, error: lErr } = await supabase
    .from("leads")
    .select("id, user_id, name, phone, state, beneficiary, beneficiary_name, military_branch")
    .eq("id", lead_id).eq("user_id", requesterId).maybeSingle();
  if (lErr) return json(500, { error: lErr.message });
  if (!lead) return json(404, { error: "Lead not found or not owned by user" });

  // 2) Must have a phone to text
  if (!S(lead.phone)) return json(200, { ok: true, sent: false, reason: "missing_phone" });

  // 3) Load messaging templates/preferences
  const { data: mt, error: tErr } = await supabase
    .from("message_templates")
    .select("*")
    .eq("user_id", requesterId)
    .maybeSingle();
  if (tErr) return json(500, { error: tErr.message });

  // Require templates enabled
  if (!mt || mt.enabled === false || mt.enabled?.new_lead === false) {
    return json(200, { ok: true, sent: false, reason: "template_disabled" });
  }

  // 4) Choose template: military vs default
  const ctx = {
    name: lead.name || "",
    state: lead.state || "",
    beneficiary: lead.beneficiary || lead.beneficiary_name || "",
  };

  const hasBranch = !!S(lead.military_branch);
  const tpl = hasBranch
    ? (mt.templates?.new_lead_military || mt.new_lead_military || mt.templates?.new_lead || mt.new_lead || "")
    : (mt.templates?.new_lead || mt.new_lead || "");

  const body = render(tpl, ctx).trim();
  if (!body) return json(200, { ok: true, sent: false, reason: "empty_template" });

  // 5) Call the centralized sender so it debits wallet, hits Telnyx, and INSERTS into public.messages
  const base = process.env.SITE_URL || process.env.URL;
  if (!base) return json(500, { error: "SITE_URL or URL not configured" });

  let res, out;
  try {
    res = await fetch(`${base}/.netlify/functions/messages-send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: lead.phone,
        body,
        lead_id: lead.id,
        requesterId,           // <- REQUIRED so user_id is set on the row
        contact_id: null,      // optional if you track it
      }),
    });
    out = await res.json().catch(() => ({}));
  } catch (e) {
    return json(502, { ok: false, error: "messages-send unreachable", detail: e?.message });
  }

  if (!res.ok || out?.error) {
    return json(res.status, { ok: false, error: out?.error || "send_failed", detail: out });
  }

  return json(200, { ok: true, sent: true, telnyx_id: out?.telnyx_id });
};
