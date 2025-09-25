// netlify/functions/call-start-v2.js
// Dials the AGENT first from one of THEIR Telnyx DIDs (local presence).
// Uses Telnyx Call Control Application *numeric* ID via `call_control_app_id`.

const fetch = require("node-fetch");
const { createClient } = require("@supabase/supabase-js");

const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const CALL_CONTROL_APP_ID = process.env.TELNYX_CALL_CONTROL_APP_ID; // e.g. 2791847680...

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;

const bad = (s, e, extra={}) => ({ statusCode: s, body: JSON.stringify({ ok:false, error:e, ...extra }) });
const ok  = (obj={ ok:true }) => ({ statusCode: 200, body: JSON.stringify(obj) });
const isE164 = n => /^\+\d{8,15}$/.test(String(n||"").trim());
const b64 = o => Buffer.from(JSON.stringify(o), "utf8").toString("base64");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return bad(405, "Method Not Allowed");
  if (!TELNYX_API_KEY) return bad(500, "TELNYX_API_KEY missing");
  if (!CALL_CONTROL_APP_ID) return bad(500, "TELNYX_CALL_CONTROL_APP_ID missing");
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return bad(500, "Supabase server creds missing");

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch { return bad(400, "Invalid JSON"); }

  const agent_id     = String(body.agent_id || body.user_id || "").trim();
  const agent_number = String(body.agent_number || "").trim(); // user's cell
  const lead_number  = String(body.lead_number  || "").trim(); // target
  const contact_id   = body.contact_id || null;

  if (!agent_id) return bad(422, "agent_id required");
  if (!isE164(agent_number)) return bad(422, "agent_number must be E.164");
  if (!isE164(lead_number))  return bad(422, "lead_number must be E.164");

  const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // pick FROM from THIS user's numbers (match NPA if possible)
  const digits = lead_number.replace(/\D+/g, "");
  const npa = digits.length >= 11 ? digits.slice(1,4) : null;

  const { data: nums, error: listErr } = await supa
    .from("agent_numbers")
    .select("telnyx_number, area_code")
    .eq("agent_id", agent_id)
    .order("purchased_at", { ascending: true });

  if (listErr) return bad(500, "DB list error: " + listErr.message);
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

  const createPayload = {
    to: agent_number,
    from: callerId,                      // MUST be their DID
    call_control_app_id: String(CALL_CONTROL_APP_ID), // <-- always this field
    client_state,
    timeout_secs: 45,
  };

  try {
    const r = await fetch("https://api.telnyx.com/v2/calls", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TELNYX_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(createPayload),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      // Return what we sent (minus secrets) so we can see it in the browser
      return bad(r.status, j?.errors?.[0]?.detail || j?.error || "Telnyx error", {
        telnyx_status: r.status,
        sent: { ...createPayload },
      });
    }
    return ok({ call_leg_id: j?.data?.call_leg_id || null });
  } catch (e) {
    return bad(500, e?.message || "Unexpected error");
  }
};
