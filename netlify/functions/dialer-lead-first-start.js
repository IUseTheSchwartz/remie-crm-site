// File: netlify/functions/dialer-lead-first-start.js
// Starts a LEAD-FIRST call for the Auto Dialer.
//
// - Calls the LEAD first (Leg A).
// - On lead answer + press 1, telnyx-voice-webhook transfers to the AGENT and bridges.
// - client_state.kind = "crm_outbound_lead_leg" to activate lead_first logic in the webhook.

const fetch = require("node-fetch");
const { createClient } = require("@supabase/supabase-js");

/* ----------- ENV ----------- */
// Prefer CALL_CONTROL_APP_ID (your env), fall back to older names
const TELNYX_API_KEY = process.env.TELNYX_API_KEY || "";
const TELNYX_CALL_CONTROL_APP_ID =
  process.env.TELNYX_CALL_CONTROL_APP_ID ||
  process.env.TELNYX_VOICE_APP_ID ||
  process.env.TELNYX_CONNECTION_ID ||
  "";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE ||
  "";

/* ---------- Supabase (service) ---------- */
const supa =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE)
    : null;

/* ---------- Helpers ---------- */
function json(body, status = 200) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
const onlyDigits = (s) => String(s || "").replace(/\D+/g, "");
function toE164(us) {
  if (!us) return null;
  const d = onlyDigits(us);
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  if (d.length === 10) return `+1${d}`;
  if (String(us).startsWith("+")) return String(us);
  return null;
}
function npaOf(e164) {
  const m = String(e164 || "").match(/^\+1?(\d{10})$/);
  return m ? m[1].slice(0, 3) : null;
}

/**
 * Pick best caller ID from agent_numbers for a given lead E.164:
 * 1) exact NPA match
 * 2) else numerically closest NPA
 * 3) else first available
 */
function pickBestCallerId(leadE164, agentNums = []) {
  if (!agentNums.length || !leadE164) return null;
  const leadNpa = Number(npaOf(leadE164)) || null;
  const pool = Array.from(
    new Set(agentNums.map((n) => toE164(n.telnyx_number)).filter(Boolean))
  );

  if (leadNpa != null) {
    const exact = pool.find((num) => Number(npaOf(num)) === leadNpa);
    if (exact) return exact;

    let best = null,
      bestDist = Infinity;
    for (const num of pool) {
      const n = Number(npaOf(num));
      if (!Number.isFinite(n)) continue;
      const dist = Math.abs(n - leadNpa);
      if (dist < bestDist) {
        best = num;
        bestDist = dist;
      }
    }
    if (best) return best;
  }
  return pool[0] || null;
}

/** Read user_id from the Supabase JWT in Authorization header (via service client) */
async function getUserIdFromSupabaseJWT(authz) {
  try {
    if (!authz || !supa) return null;
    const token = String(authz).replace(/^Bearer\s+/i, "");
    // ✅ Correct way: use service client to validate the user JWT
    const { data, error } = await supa.auth.getUser(token);
    if (error) return null;
    return data?.user?.id || null;
  } catch {
    return null;
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST")
    return json({ ok: false, error: "Method not allowed" }, 405);

  if (!TELNYX_API_KEY || !TELNYX_CALL_CONTROL_APP_ID) {
    return json(
      { ok: false, error: "Missing TELNYX_API_KEY or TELNYX_CALL_CONTROL_APP_ID" },
      500
    );
  }
  if (!supa)
    return json({ ok: false, error: "Supabase service role not configured" }, 500);

  // Auth
  const authz = event.headers.authorization || event.headers.Authorization || "";
  const user_id = await getUserIdFromSupabaseJWT(authz);
  if (!user_id) return json({ ok: false, error: "Not signed in" }, 401);

  // Inputs
  let body = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }

  const agent_number = toE164(body.agent_number);
  const lead_number = toE164(body.lead_number);
  let from_number = toE164(body.from_number || body.caller_id || null); // optional
  const contact_id = body.contact_id || null;

  const record = !!body.record;
  const ring_timeout = Number(body.ring_timeout || 25);
  const ringback_url = body.ringback_url || "";
  const session_id = body.session_id || null;

  // NEW: recorded audio URLs (sent from frontend)
  const press1_audio_url =
    body.press1_audio_url || body.press1AudioUrl || "";
  const voicemail_audio_url =
    body.voicemail_audio_url || body.voicemailAudioUrl || "";

  if (!agent_number || !lead_number) {
    return json(
      { ok: false, error: "agent_number and lead_number are required in E.164" },
      400
    );
  }

  // If UI didn’t pass a DID, try to pick best; else fall back to connection default
  if (!from_number) {
    try {
      const { data: nums } = await supa
        .from("agent_numbers")
        .select("telnyx_number, is_free, purchased_at")
        .eq("agent_id", user_id)
        .order("purchased_at", { ascending: true });
      const best = pickBestCallerId(lead_number, nums || []);
      from_number = best || null;
    } catch (e) {
      // leave null → connection default
    }
  }

  // Prepare client_state
  const clientState = {
    kind: "crm_outbound_lead_leg",
    flow: "lead_first",
    user_id,
    contact_id,
    lead_number,
    agent_number,
    from_number, // for visibility in webhook logs
    record,
    ringback_url,
    session_id,
    press1_audio_url: press1_audio_url || null,
    voicemail_audio_url: voicemail_audio_url || null,
  };
  const client_state_b64 = Buffer.from(JSON.stringify(clientState), "utf8").toString(
    "base64"
  );

  // Build Telnyx payload
  const payload = {
    to: lead_number,
    connection_id: TELNYX_CALL_CONTROL_APP_ID,
    client_state: client_state_b64,
    timeout_secs: ring_timeout,
  };
  if (from_number) payload.from = from_number; // omit to use connection default

  // Create call
  let resp, data;
  try {
    resp = await fetch("https://api.telnyx.com/v2/calls", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TELNYX_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    data = await resp.json().catch(() => ({}));
  } catch (e) {
    return json(
      { ok: false, error: e?.message || "Network error creating call" },
      502
    );
  }

  if (!resp.ok) {
    const errMsg =
      data?.errors?.[0]?.detail ||
      data?.message ||
      `Telnyx error (${resp.status})`;
    return json({ ok: false, error: errMsg }, 502);
  }

  const callObj = data?.data || data || {};
  // IMPORTANT: Telnyx returns `call_control_id` (not `id`)
  const call_leg_id = callObj.call_control_id || callObj.id || null;
  const call_session_id = callObj.call_session_id || null;

  // light console trace
  try {
    console.log("[lead-first-start]", {
      call_leg_id,
      call_session_id,
      used_from_number: from_number || "(connection default)",
    });
  } catch {}

  return json({
    ok: true,
    call_leg_id,
    call_session_id,
    contact_id,
    used_from_number: from_number || null,
  });
};
