// File: netlify/functions/call-start.js
// AGENT-FIRST, webhook-compatible client_state (keeps legacy keys so your old code still triggers)

const fetch = require("node-fetch");
const { createClient } = require("@supabase/supabase-js");

const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const CALL_CONTROL_APP_ID = process.env.TELNYX_CALL_CONTROL_APP_ID;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;

const RINGBACK_URL = process.env.RINGBACK_URL || "";

const bad = (s, e, extra = {}) => ({ statusCode: s, body: JSON.stringify({ ok: false, error: e, ...extra }) });
const ok  = (obj = { ok: true }) => ({ statusCode: 200, body: JSON.stringify(obj) });
const isE164 = (n) => /^\+\d{8,15}$/.test(String(n || "").trim());
const b64 = (o) => Buffer.from(JSON.stringify(o), "utf8").toString("base64");

/** Minimal state maps (area code -> state) just for caller ID selection */
const NPA_STATE = { 615:"TN",629:"TN",731:"TN",865:"TN",901:"TN",931:"TN", /* … keep your full map here … */ };
const STATE_CENTROID = { TN:[35.747,-86.692], /* … keep your full map here … */ };

function distKm(a, b){const R=6371,t=x=>x*Math.PI/180;const dLa=t(b[0]-a[0]),dLo=t(b[1]-a[1]),la1=t(a[0]),la2=t(b[0]);
  const h=Math.sin(dLa/2)**2+Math.cos(la1)*Math.cos(la2)*Math.sin(dLo/2)**2;return 2*R*Math.asin(Math.sqrt(h));}
function stateFromAreaCode(npa){return NPA_STATE[Number(String(npa||"").replace(/\D+/g,""))]||null;}

function pickBestCallerId({ leadNPA, owned }) {
  const leadState = stateFromAreaCode(leadNPA);
  const exact = owned.find(x => String(x.area_code) === String(leadNPA));
  if (exact) return exact.telnyx_number;
  if (leadState){
    const same = owned.find(x => stateFromAreaCode(x.area_code) === leadState);
    if (same) return same.telnyx_number;
  }
  if (leadState && STATE_CENTROID[leadState]){
    const lp = STATE_CENTROID[leadState]; let best=null,bestD=Infinity;
    for (const row of owned){
      const st = stateFromAreaCode(row.area_code);
      const pt = STATE_CENTROID[st]; if(!st||!pt) continue;
      const d = distKm(lp, pt); if (d<bestD){bestD=d;best=row;}
    }
    if (best) return best.telnyx_number;
  }
  return owned[0]?.telnyx_number || null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return bad(405, "Method Not Allowed");
  if (!TELNYX_API_KEY) return bad(500, "TELNYX_API_KEY missing");
  if (!CALL_CONTROL_APP_ID) return bad(500, "TELNYX_CALL_CONTROL_APP_ID missing");
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return bad(500, "Supabase server creds missing");

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch { return bad(400, "Invalid JSON"); }

  const agent_id     = String(body.agent_id || body.user_id || "").trim();
  const agent_number = String(body.agent_number || "").trim(); // we call this FIRST
  const lead_number  = String(body.lead_number  || "").trim(); // webhook calls AFTER agent answers
  const contact_id   = body.contact_id || null;

  if (!agent_id) return bad(422, "agent_id required");
  if (!isE164(agent_number)) return bad(422, "agent_number must be E.164");
  if (!isE164(lead_number)) return bad(422, "lead_number must be E.164");
  if (!lead_number.startsWith("+1")) return bad(422, "US numbers only (+1)");

  const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Fetch owned numbers (oldest first)
  const { data: nums, error: listErr } = await supa
    .from("agent_numbers")
    .select("telnyx_number, area_code")
    .eq("agent_id", agent_id)
    .order("purchased_at", { ascending: true });

  if (listErr) return bad(500, "DB list error: " + listErr.message);
  if (!nums || nums.length === 0) return bad(400, "You don’t own any Telnyx numbers yet");

  // Recording flag
  let recordFlag = false;
  try {
    const { data: rec } = await supa
      .from("call_recording_settings")
      .select("record_outbound_enabled")
      .eq("user_id", agent_id)
      .maybeSingle();
    recordFlag = !!rec?.record_outbound_enabled;
  } catch {}

  // Choose best caller ID to show the LEAD
  const digits = lead_number.replace(/\D+/g,"");
  const leadNPA = digits.length >= 11 ? digits.slice(1,4) : (digits.length === 10 ? digits.slice(0,3) : null);
  const callerId = pickBestCallerId({ leadNPA, owned: nums });
  if (!callerId) return bad(400, "Could not choose a caller ID");

  // ⚠️ Compatibility client_state — use the "old" kind your webhook likely keys on
  const client_state = b64({
    // Legacy name your webhook likely used when it worked:
    kind: "crm_outbound_agent",
    // Also include a few aliases so any newer code still recognizes it:
    compat_kind: "crm_outbound_agent_leg",
    flow: "agent_first",
    // IDs:
    user_id: agent_id,
    agent_id,
    contact_id,
    // Numbers (both legacy and new keys):
    lead_number,                  // new
    to: lead_number,              // legacy alias some webhooks use
    from_number: callerId,        // new
    ani: callerId,                // legacy alias for caller ID
    agent_number,                 // for reference if webhook needs it
    // Behavior flags:
    ringback_url: RINGBACK_URL || null,
    b_timeout_secs: 25,
    record: recordFlag
  });

  // Create the AGENT leg first
  const createPayload = {
    to: agent_number,
    from: callerId, // any owned DID (lead will see callerId on their leg)
    connection_id: String(CALL_CONTROL_APP_ID),
    client_state,
    timeout_secs: 45
  };

  try {
    const r = await fetch("https://api.telnyx.com/v2/calls", {
      method: "POST",
      headers: { Authorization: `Bearer ${TELNYX_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(createPayload),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      return bad(r.status, j?.errors?.[0]?.detail || j?.error || "Telnyx error", {
        telnyx_status: r.status, sent: { ...createPayload }
      });
    }

    // Tiny anti-silence whisper to the agent (so they don’t hear dead air if webhook takes a sec)
    try {
      const agentLegId = j?.data?.call_leg_id;
      if (agentLegId) {
        await fetch(`https://api.telnyx.com/v2/calls/${agentLegId}/actions/speak`, {
          method: "POST",
          headers: { Authorization: `Bearer ${TELNYX_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ payload: "Connecting your prospect…", voice: "female", language: "en-US" })
        });
      }
    } catch {}

    return ok({ call_leg_id: j?.data?.call_leg_id || null });
  } catch (e) {
    return bad(500, e?.message || "Unexpected error");
  }
};
