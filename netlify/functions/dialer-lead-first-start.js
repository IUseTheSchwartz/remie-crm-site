// File: netlify/functions/dialer-lead-first-start.js
// Starts a LEAD-FIRST call (Auto Dialer):
// - Leg A = LEAD (we dial the lead first)
// - On lead answer, your telnyx-voice-webhook.js transfers to the AGENT and bridges
// - Local presence: choose caller ID from agent_numbers
//     1) Exact NPA (area code) match
//     2) Else: numerically nearest NPA among agent-owned DIDs (heuristic proximity)
//     3) Else: any owned DID
//
// Request body:
//  {
//    agent_number: "+16155551234",
//    lead_number:  "+15055559876",
//    contact_id:   "<uuid>",
//    // Optional overrides:
//    from_number:  "+15055550123", // if present, we use this and skip selection
//    record:       true,
//    ring_timeout: 25,
//    ringback_url: "",
//    session_id:   "autodialer-run-abc123"
//  }
//
// Response: { ok: true, call_leg_id, call_session_id?, contact_id }

const fetch = require("node-fetch");
const { createClient } = require("@supabase/supabase-js");

const TELNYX_API_KEY = process.env.TELNYX_API_KEY || "";
const TELNYX_VOICE_APP_ID =
  process.env.TELNYX_VOICE_APP_ID || process.env.TELNYX_CONNECTION_ID || "";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE ||
  "";

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

const onlyDigits = (s) => String(s || "").replace(/\D/g, "");
function toE164(us) {
  const d = onlyDigits(us);
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  if (d.length === 10) return `+1${d}`;
  if (String(us || "").startsWith("+")) return String(us);
  return null;
}
function getNpa(e164) {
  // expects +1NXXNXXXXXX
  const m = String(e164 || "").match(/^\+1(\d{3})\d{7}$/);
  return m ? m[1] : null;
}

async function getUserIdFromSupabaseJWT(authz) {
  try {
    if (!authz || !SUPABASE_URL) return null;
    const token = String(authz).replace(/^Bearer\s+/i, "");
    // Use the user JWT to create a short-lived client and read the user object
    const userClient = createClient(SUPABASE_URL, token);
    const { data, error } = await userClient.auth.getUser();
    if (error) return null;
    return data?.user?.id || null;
  } catch {
    return null;
  }
}

/** Fetch all DIDs for the agent, return as [{telnyx_number, area_code}] */
async function fetchAgentNumbers(agent_id) {
  if (!supa || !agent_id) return [];
  try {
    const { data, error } = await supa
      .from("agent_numbers")
      .select("telnyx_number, area_code")
      .eq("agent_id", agent_id)
      .order("purchased_at", { ascending: true });
    if (error) return [];
    const rows = Array.isArray(data) ? data : [];
    // Normalize format to E.164 for safety
    return rows
      .map((r) => ({
        telnyx_number: toE164(r.telnyx_number),
        area_code: String(r.area_code || "").replace(/\D/g, "").slice(0, 3),
      }))
      .filter((r) => r.telnyx_number && /^\d{3}$/.test(r.area_code));
  } catch {
    return [];
  }
}

/** Choose best caller ID for local presence:
 *  - exact NPA match
 *  - else: numerically nearest NPA (min |leadNpa - didNpa|)
 *  - else: first available
 */
function pickLocalPresenceDid(leadNpa, dids = []) {
  if (!leadNpa || dids.length === 0) return null;
  // 1) Exact match
  const exact = dids.find((d) => d.area_code === leadNpa);
  if (exact) return exact.telnyx_number;

  // 2) Numeric proximity heuristic
  const leadNum = Number(leadNpa);
  let best = null;
  let bestDist = Infinity;
  for (const d of dids) {
    const n = Number(d.area_code);
    const dist = Math.abs(n - leadNum);
    if (dist < bestDist) {
      bestDist = dist;
      best = d.telnyx_number;
    }
  }
  if (best) return best;

  // 3) Any
  return dids[0]?.telnyx_number || null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST")
    return json({ ok: false, error: "Method not allowed" }, 405);

  if (!TELNYX_API_KEY || !TELNYX_VOICE_APP_ID) {
    return json(
      { ok: false, error: "Missing TELNYX env (API key / voice app id)" },
      500
    );
  }

  // Auth (same style as other functions)
  const authz =
    event.headers.authorization || event.headers.Authorization || "";
  const user_id = await getUserIdFromSupabaseJWT(authz);
  if (!user_id) return json({ ok: false, error: "Not signed in" }, 401);

  // Parse body
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }

  const agent_number = toE164(body.agent_number);
  const lead_number = toE164(body.lead_number);
  const contact_id = body.contact_id || null;

  const explicit_from = toE164(body.from_number || body.caller_id || "");
  const record = !!body.record;
  const ring_timeout = Math.max(5, Math.min(60, Number(body.ring_timeout || 25)));
  const ringback_url = body.ringback_url || "";
  const session_id = body.session_id || null;

  if (!agent_number) {
    return json({ ok: false, error: "agent_number is required (E.164)" }, 400);
  }
  if (!lead_number) {
    return json({ ok: false, error: "lead_number is required (E.164)" }, 400);
  }

  // Decide caller ID (from_number)
  let from_number = explicit_from || null;
  if (!from_number) {
    // Local presence selection from agent_numbers
    const dids = await fetchAgentNumbers(user_id);
    if (dids.length > 0) {
      const leadNpa = getNpa(lead_number);
      const chosen = pickLocalPresenceDid(leadNpa, dids);
      if (chosen) from_number = chosen;
    }
  }

  // Build client_state (consumed by telnyx-voice-webhook.js)
  const clientState = {
    kind: "crm_outbound_lead_leg",
    flow: "lead_first",
    user_id,
    contact_id,
    lead_number,
    agent_number,
    ...(from_number ? { from_number } : {}),
    record,
    ringback_url,
    session_id,
  };
  const client_state_b64 = Buffer.from(
    JSON.stringify(clientState),
    "utf8"
  ).toString("base64");

  // Create outbound call to the LEAD (Leg A)
  const url = "https://api.telnyx.com/v2/calls";
  const payload = {
    to: lead_number,
    // Only send "from" if we actually selected one; otherwise Telnyx uses the connection default
    ...(from_number ? { from: from_number } : {}),
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
  return json({
    ok: true,
    call_leg_id: call?.id || null, // Leg A call_control_id
    call_session_id: call?.call_session_id || null,
    contact_id,
  });
};
