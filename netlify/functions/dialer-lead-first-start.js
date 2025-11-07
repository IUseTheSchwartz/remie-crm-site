// File: netlify/functions/dialer-lead-first-start.js
// Starts a LEAD-FIRST call (Auto Dialer):
// - Calls the LEAD first (Leg A), then your existing webhook transfers to the AGENT on lead answer.
// - Uses telnyx-voice-webhook.js (lead_first branch) via client_state.kind = "crm_outbound_lead_leg"

const fetch = require("node-fetch");
const { createClient } = require("@supabase/supabase-js");

const TELNYX_API_KEY = process.env.TELNYX_API_KEY || "";
// Telnyx Call Control application / connection id (same one your agent-first flow uses)
const TELNYX_VOICE_APP_ID =
  process.env.TELNYX_VOICE_APP_ID || process.env.TELNYX_CONNECTION_ID || "";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE || "";

const supa =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE)
    : null;

function json(body, statusCode = 200) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function onlyDigits(s) {
  return String(s || "").replace(/\D/g, "");
}
function toE164(us) {
  const d = onlyDigits(us);
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  if (d.length === 10) return `+1${d}`;
  if (us && String(us).startsWith("+")) return String(us);
  return null;
}

// --- Decode Supabase JWT locally to extract the user_id (sub) ---
function decodeJwtSub(bearer) {
  if (!bearer) return null;
  const token = String(bearer).replace(/^Bearer\s+/i, "");
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const json = JSON.parse(Buffer.from(parts[1], "base64").toString("utf8"));
    return json?.sub || null; // Supabase user id is in `sub`
  } catch {
    return null;
  }
}
async function getUserIdFromSupabaseJWT(authz) {
  return decodeJwtSub(authz);
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  // Auth (same pattern as your other functions)
  const authz = event.headers.authorization || event.headers.Authorization || "";
  const user_id = await getUserIdFromSupabaseJWT(authz);
  if (!user_id) return json({ ok: false, error: "Not signed in" }, 401);

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }

  const lead_number = toE164(body.lead_number);
  const agent_number = toE164(body.agent_number);
  const from_number = toE164(body.from_number || body.caller_id);
  const contact_id = body.contact_id || null;

  const record = !!body.record;
  const ring_timeout = Number(body.ring_timeout || 25);
  const ringback_url = body.ringback_url || ""; // optional
  const session_id = body.session_id || null; // optional UI session id for analytics

  if (!TELNYX_API_KEY || !TELNYX_VOICE_APP_ID) {
    return json(
      { ok: false, error: "Missing TELNYX env (API key / voice app id)" },
      500
    );
  }
  if (!lead_number || !agent_number) {
    return json(
      { ok: false, error: "lead_number and agent_number are required (E.164)" },
      400
    );
  }
  if (!from_number) {
    return json({ ok: false, error: "from_number (caller ID) is required" }, 400);
  }

  // Leg A must be the LEAD so webhook's lead-first branch runs
  const clientState = {
    kind: "crm_outbound_lead_leg",
    flow: "lead_first",
    user_id,
    contact_id,
    lead_number,
    agent_number,
    from_number,
    record,
    ringback_url,
    session_id,
  };
  const client_state_b64 = Buffer.from(JSON.stringify(clientState), "utf8").toString(
    "base64"
  );

  // Create the outbound call to the LEAD (Leg A)
  const url = "https://api.telnyx.com/v2/calls";
  const payload = {
    to: lead_number,
    from: from_number,
    connection_id: TELNYX_VOICE_APP_ID,
    client_state: client_state_b64,
    timeout_secs: ring_timeout,
  };

  let resp, data;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TELNYX_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    data = await resp.json();
  } catch (e) {
    return json(
      { ok: false, error: e?.message || "Network error creating call" },
      502
    );
  }

  if (!resp.ok) {
    return json(
      {
        ok: false,
        error:
          data?.errors?.[0]?.detail ||
          data?.message ||
          `Telnyx error (${resp?.status})`,
      },
      502
    );
  }

  const call = data?.data || {};
  // call.id is the call_control_id (Leg A); call.call_session_id may also be returned
  return json({
    ok: true,
    call_leg_id: call?.id || null,
    call_session_id: call?.call_session_id || null,
    contact_id,
  });
};
