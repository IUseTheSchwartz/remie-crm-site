// netlify/functions/call-start.js
// Dials the AGENT first (their cell), FROM one of the agent's Telnyx DIDs,
// using your Voice API connection_id. Your webhook should transfer to the lead
// when the agent answers (we pass client_state with the lead number).

const fetch = require("node-fetch");
const { createClient } = require("@supabase/supabase-js");

const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const TELNYX_CONNECTION_ID = process.env.TELNYX_CONNECTION_ID; // Voice API "connection" id (required for /v2/calls)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;

function bad(status, error, extra = {}) {
  return { statusCode: status, body: JSON.stringify({ ok: false, error, ...extra }) };
}
function isE164(n) { return /^\+\d{8,15}$/.test(String(n || "").trim()); }
function b64(obj) { return Buffer.from(JSON.stringify(obj), "utf8").toString("base64"); }

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return bad(405, "Method Not Allowed");

  // env checks
  if (!TELNYX_API_KEY) return bad(500, "TELNYX_API_KEY is not set");
  if (!TELNYX_CONNECTION_ID) return bad(500, "TELNYX_CONNECTION_ID is not set (Voice API connection id)");
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return bad(500, "Supabase server credentials are not configured");

  // body
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch { return bad(400, "Invalid JSON"); }

  const agent_id     = (body.agent_id || "").trim();
  const agent_number = (body.agent_number || "").trim(); // your personal phone (we call you first)
  const lead_number  = (body.lead_number  || "").trim(); // the lead you want to reach

  if (!agent_id) return bad(422, "agent_id is required");
  if (!isE164(agent_number)) return bad(422, "agent_number must be E.164 (+1...)");
  if (!isE164(lead_number)) return bad(422, "lead_number must be E.164 (+1...)");

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Pick best caller ID from agent_numbers (same NPA as lead if possible)
  const npa = lead_number.replace(/\D+/g, "").slice(1, 4); // digits 2-4 of +1NXX...
  const { data: nums, error: listErr } = await supabase
    .from("agent_numbers")
    .select("telnyx_number, area_code")
    .eq("agent_id", agent_id)
    .order("purchased_at", { ascending: true });

  if (listErr) return bad(500, "DB error listing numbers: " + listErr.message);
  if (!nums || nums.length === 0) return bad(400, "You don’t own any Telnyx numbers yet");

  let callerId = nums.find(x => x.area_code === npa)?.telnyx_number || nums[0].telnyx_number;

  // Embed info for your webhook to transfer/bridge on answer
  const client_state = b64({
    kind: "crm_outbound",
    user_id: agent_id,
    lead_number,
    from_number: callerId
  });

  // Dial agent first FROM your Telnyx DID through the Voice API connection
  try {
    const r = await fetch("https://api.telnyx.com/v2/calls", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TELNYX_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        to: agent_number,            // call the agent first
        from: callerId,              // must be one of your Telnyx numbers
        connection_id: TELNYX_CONNECTION_ID, // required by /v2/calls
        client_state,                // for your webhook logic
        timeout_secs: 45
      }),
    });

    const j = await r.json();
    if (!r.ok) {
      const msg = j?.errors?.[0]?.detail || j?.error || JSON.stringify(j);
      return bad(r.status, "Telnyx dial failed: " + msg, { telnyx_status: r.status });
    }

    // Success; webhook will handle transfer to the lead when the agent answers
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, call_leg_id: j?.data?.call_leg_id || null })
    };
  } catch (e) {
    return bad(500, e?.message || "Unexpected error dialing");
  }
};
