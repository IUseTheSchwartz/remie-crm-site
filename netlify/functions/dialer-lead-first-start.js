// File: netlify/functions/dialer-lead-first-start.js
let fetchFn = globalThis.fetch;
if (!fetchFn) { try { fetchFn = require("node-fetch"); } catch {} }
const { createClient } = require("@supabase/supabase-js");

/* ----------- ENV ----------- */
const TELNYX_API_KEY = process.env.TELNYX_API_KEY || "";

// Accept the common env names you use
const TELNYX_CONNECTION_ID =
  process.env.TELNYX_VOICE_APP_ID ||
  process.env.TELNYX_CONNECTION_ID ||
  process.env.TELNYX_CALL_CONTROL_APP_ID ||
  process.env.TELNYX_CALL_CONTROL_APPLICATION_ID ||
  "";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE || "";

/* ---------- Supabase (service) ---------- */
const supa =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE)
    : null;

/* ---------- Helpers ---------- */
function json(body, status = 200) {
  return { statusCode: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
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
function pickBestCallerId(leadE164, agentNums = []) {
  if (!agentNums?.length || !leadE164) return null;
  const leadNpa = Number(npaOf(leadE164));
  const pool = agentNums.map(n => toE164(n.telnyx_number)).filter(Boolean);
  if (Number.isFinite(leadNpa)) {
    const exact = pool.find(num => Number(npaOf(num)) === leadNpa);
    if (exact) return exact;
    let best = null, bestDist = Infinity;
    for (const num of pool) {
      const n = Number(npaOf(num)); if (!Number.isFinite(n)) continue;
      const dist = Math.abs(n - leadNpa);
      if (dist < bestDist) { best = num; bestDist = dist; }
    }
    if (best) return best;
  }
  return pool[0] || null;
}

/** Decode the Supabase JWT using the service client */
async function getUserIdFromSupabaseJWT(authz) {
  try {
    if (!authz || !supa) return null;
    const token = String(authz).replace(/^Bearer\s+/i, "");
    const { data, error } = await supa.auth.getUser(token);
    if (error) return null;
    return data?.user?.id || null;
  } catch { return null; }
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  if (!TELNYX_API_KEY || !TELNYX_CONNECTION_ID) {
    return json({
      ok: false,
      error:
        "Missing TELNYX_API_KEY or connection id (set one of: TELNYX_VOICE_APP_ID, TELNYX_CONNECTION_ID, TELNYX_CALL_CONTROL_APP_ID, TELNYX_CALL_CONTROL_APPLICATION_ID)"
    }, 500);
  }
  if (!supa) return json({ ok: false, error: "Supabase service role not configured" }, 500);
  if (!fetchFn) return json({ ok: false, error: "Fetch not available in runtime" }, 500);

  // Auth
  const authz = event.headers.authorization || event.headers.Authorization || "";
  const user_id = await getUserIdFromSupabaseJWT(authz);
  if (!user_id) return json({ ok: false, error: "Not signed in" }, 401);

  // Body
  let body = {};
  try { body = JSON.parse(event.body || "{}"); }
  catch { return json({ ok: false, error: "Invalid JSON" }, 400); }

  const agent_number = toE164(body.agent_number);
  const lead_number  = toE164(body.lead_number);
  let from_number    = toE164(body.from_number || body.caller_id || null);
  const contact_id   = body.contact_id || null;

  const record       = !!body.record;
  const ring_timeout = Number(body.ring_timeout || 25);
  const ringback_url = body.ringback_url || "";
  const session_id   = body.session_id || null;

  if (!agent_number || !lead_number) {
    return json({ ok: false, error: "agent_number and lead_number are required in E.164" }, 400);
  }

  // Auto-pick DID if not provided
  if (!from_number) {
    try {
      const { data: nums, error } = await supa
        .from("agent_numbers")
        .select("telnyx_number, is_free, purchased_at")
        .eq("agent_id", user_id)
        .order("purchased_at", { ascending: true });
      if (!error) from_number = pickBestCallerId(lead_number, nums || []) || null;
    } catch (e) {
      console.log("[dialer] agent_numbers lookup:", e?.message);
    }
  }

  // Client state for your webhook (lead-first)
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
  const client_state_b64 = Buffer.from(JSON.stringify(clientState), "utf8").toString("base64");

  // Telnyx call create
  const payload = {
    to: lead_number,
    connection_id: TELNYX_CONNECTION_ID,
    client_state: client_state_b64,
    timeout_secs: ring_timeout,
  };
  if (from_number) payload.from = from_number;

  let resp, data;
  try {
    resp = await fetchFn("https://api.telnyx.com/v2/calls", {
      method: "POST",
      headers: { Authorization: `Bearer ${TELNYX_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    data = await resp.json().catch(() => ({}));
  } catch (e) {
    return json({ ok: false, error: e?.message || "Network error creating call" }, 502);
  }

  if (!resp.ok) {
    const errMsg = data?.errors?.[0]?.detail || data?.message || `Telnyx error (${resp.status})`;
    return json({ ok: false, error: errMsg }, 502);
  }

  const call = data?.data || {};
  return json({
    ok: true,
    call_leg_id: call?.id || null,
    call_session_id: call?.call_session_id || null,
    contact_id,
    used_from_number: from_number || null,
  });
};
