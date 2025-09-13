// Sends the “new lead” auto text by rendering the user’s template.
// Pulls agent info from public.agent_profiles and sends via messages-send.
const { createClient } = require("@supabase/supabase-js");

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};
const S = (x) => (x == null ? "" : String(x).trim());

function json(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  const {
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE,
    SITE_URL,
    URL,
    TELNYX_FROM_NUMBER, // fallback for agent_phone
  } = process.env;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    return json(500, { error: "Supabase env not set" });
  }

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return json(400, { error: "Invalid JSON" }); }

  const leadId = body.lead_id || body.leadId;
  const requesterId = body.requesterId || null;
  if (!leadId || !requesterId) {
    return json(400, { error: "lead_id and requesterId are required" });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, {
    auth: { persistSession: false },
  });

  // 1) Load lead
  const { data: lead, error: LErr } = await supabase
    .from("leads")
    .select("id, user_id, name, phone, state, beneficiary, beneficiary_name, military_branch")
    .eq("id", leadId)
    .maybeSingle();
  if (LErr || !lead) return json(404, { error: "lead_not_found" });

  // 2) Load template row
  const { data: mt, error: TErr } = await supabase
    .from("message_templates")
    .select("*")
    .eq("user_id", lead.user_id)
    .maybeSingle();
  if (TErr || !mt) return json(200, { sent: false, reason: "template_missing" });

  const enabled =
    typeof mt.enabled === "boolean" ? mt.enabled : (mt.enabled?.new_lead ?? true);
  if (!enabled) return json(200, { sent: false, reason: "template_disabled" });

  const hasBranch = !!S(lead.military_branch);
  const tpl = hasBranch
    ? (mt.templates?.new_lead_military || mt.new_lead_military || mt.templates?.new_lead || mt.new_lead || "")
    : (mt.templates?.new_lead || mt.new_lead || "");
  const phone = S(lead.phone);
  if (!S(tpl)) return json(200, { sent: false, reason: "empty_template" });
  if (!phone)   return json(200, { sent: false, reason: "missing_phone" });

  // 3) Load agent profile (your table)
  let agent_name = "";
  let agent_phone = S(TELNYX_FROM_NUMBER);  // fallback to sending number
  let calendly_link = "";
  try {
    const { data: agent, error: AErr } = await supabase
      .from("agent_profiles")
      .select("full_name, phone, calendly_url")
      .eq("user_id", lead.user_id)
      .maybeSingle();

    if (!AErr && agent) {
      agent_name    = S(agent.full_name) || agent_name;
      agent_phone   = S(agent.phone) || agent_phone;
      calendly_link = S(agent.calendly_url) || calendly_link;
    }
  } catch (e) {
    // non-fatal
  }

  // 4) Build render context (match your placeholders)
  const first_name  = S(lead.name).split(/\s+/)[0] || "";
  const beneficiary = S(lead.beneficiary) || S(lead.beneficiary_name);

  const ctx = {
    // lead values
    first_name,
    name: S(lead.name),
    state: S(lead.state),
    beneficiary,
    // agent values
    agent_name,
    agent_phone,
    calendly_link,
  };

  // 5) Render template {{var}}
  const textBody = String(tpl)
    .replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, k) => S(ctx[k]))
    .trim();
  if (!textBody) return json(200, { sent: false, reason: "render_empty" });

  // 6) Send through messages-send so it records in public.messages
  const base = SITE_URL || URL;
  if (!base) return json(500, { error: "Missing SITE_URL/URL" });

  const res = await fetch(`${base}/.netlify/functions/messages-send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      to: phone,
      body: textBody,
      requesterId,          // <- critical so your UI filters by user
      lead_id: lead.id,
    }),
  });

  const out = await res.json().catch(() => ({}));
  if (!res.ok || out?.error) {
    return json(200, { ok: false, error: "send_failed", telnyx_status: res.status, telnyx_response: out });
  }
  return json(200, { ok: true, sent: true, telnyx_id: out.telnyx_id });
};
