// netlify/functions/call-start.js
// Dials the AGENT first from one of THEIR Telnyx DIDs (local presence).
// Uses Call Control Application ID (numeric) via `call_control_app_id`.

const fetch = require("node-fetch");
const { supaAdmin } = require("./_supa");

const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
// <-- Put the numeric "Application ID" from the portal here (via env)
const CALL_CONTROL_APP_ID =
  process.env.TELNYX_CALL_CONTROL_APP_ID ||
  process.env.TELNYX_CONNECTION_ID || // tolerate older env name
  null;

function bad(status, error, extra = {}) {
  return { statusCode: status, body: JSON.stringify({ ok: false, error, ...extra }) };
}
const isE164 = (n) => /^\+\d{8,15}$/.test(String(n || "").trim());
const b64 = (o) => Buffer.from(JSON.stringify(o), "utf8").toString("base64");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return bad(405, "Method Not Allowed");
  if (!TELNYX_API_KEY) return bad(500, "TELNYX_API_KEY is not set");
  if (!CALL_CONTROL_APP_ID) return bad(500, "TELNYX_CALL_CONTROL_APP_ID is not set");

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch { return bad(400, "Invalid JSON"); }

  const agent_id     = String(body.agent_id || body.user_id || "").trim();
  const agent_number = String(body.agent_number || "").trim(); // your cell (we call you first)
  const lead_number  = String(body.lead_number  || "").trim(); // the lead
  const contact_id   = body.contact_id || null;

  if (!agent_id) return bad(422, "agent_id is required");
  if (!isE164(agent_number)) return bad(422, "agent_number must be E.164 (+1...)");
  if (!isE164(lead_number))  return bad(422, "lead_number must be E.164 (+1...)");

  const supa = supaAdmin();

  // Pick FROM from THIS user's numbers only (match NPA if possible)
  const digits = lead_number.replace(/\D+/g, "");
  const npa = digits.length >= 11 ? digits.slice(1, 4) : null;

  const { data: nums, error: listErr } = await supa
    .from("agent_numbers")
    .select("telnyx_number, area_code")
    .eq("agent_id", agent_id)
    .order("purchased_at", { ascending: true });

  if (listErr) return bad(500, "DB error listing numbers: " + listErr.message);
  if (!nums || nums.length === 0) return bad(400, "You don’t own any Telnyx numbers yet");

  const callerId = (npa && nums.find(x => x.area_code === npa)?.telnyx_number) || nums[0].telnyx_number;

  const client_state = b64({
    kind: "crm_outbound",
    user_id: agent_id,
    contact_id,
    lead_number,
    agent_number,
    from_number: callerId,
  });

  try {
    const r = await fetch("https://api.telnyx.com/v2/calls", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TELNYX_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        to: agent_number,                 // call the agent first
        from: callerId,                   // must be THEIR Telnyx DID
        call_control_app_id: String(CALL_CONTROL_APP_ID), // <-- IMPORTANT (numeric ID)
        client_state,
        timeout_secs: 45,
      }),
    });

    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = j?.errors?.[0]?.detail || j?.error || JSON.stringify(j);
      return bad(r.status, "Telnyx dial failed: " + msg, { telnyx_status: r.status, bodySent: "call_control_app_id" });
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true, call_leg_id: j?.data?.call_leg_id || null }) };
  } catch (e) {
    return bad(500, e?.message || "Unexpected error dialing");
  }
};
