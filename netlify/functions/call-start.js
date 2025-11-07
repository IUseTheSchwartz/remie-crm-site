// File: netlify/functions/call-start.js
// AGENT-FIRST flow: we call the AGENT first; webhook will call the LEAD and bridge on agent answer.
// Caller ID selection priority:
// 1) Exact area code (NPA) match
// 2) Same state as the lead
// 3) Geographically closest state (by centroid distance)
// 4) Oldest owned number
//
// Notes:
// - Keep your full NPA_STATE and STATE_CENTROID maps for best geo CID picking (examples included).
// - Webhook should key off kind: "crm_outbound_agent" and mark stage=answered only on BRIDGE.

const fetch = require("node-fetch");
const { createClient } = require("@supabase/supabase-js");

const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const CALL_CONTROL_APP_ID = process.env.TELNYX_CALL_CONTROL_APP_ID;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;

// Optional; used mainly for LEAD-FIRST ringback. Left here for compatibility.
const RINGBACK_URL = process.env.RINGBACK_URL || "";

const bad = (s, e, extra = {}) => ({ statusCode: s, body: JSON.stringify({ ok: false, error: e, ...extra }) });
const ok  = (obj = { ok: true }) => ({ statusCode: 200, body: JSON.stringify(obj) });
const isE164 = (n) => /^\+\d{8,15}$/.test(String(n || "").trim());
const b64 = (o) => Buffer.from(JSON.stringify(o), "utf8").toString("base64");

/* ------------------------------------------------------------------ */
/* Minimal examples — replace with your full maps for best results.    */
/* ------------------------------------------------------------------ */

// Area code → state (USPS) map
const NPA_STATE = {
  // TN (examples)
  423:"TN",615:"TN",629:"TN",731:"TN",865:"TN",901:"TN",931:"TN",
  // IL (examples)
  217:"IL",224:"IL",309:"IL",312:"IL",331:"IL",447:"IL",618:"IL",630:"IL",708:"IL",730:"IL",773:"IL",779:"IL",815:"IL",847:"IL",872:"IL",
  // TX (examples)
  210:"TX",214:"TX",254:"TX",281:"TX",325:"TX",346:"TX",361:"TX",409:"TX",430:"TX",432:"TX",469:"TX",512:"TX",682:"TX",713:"TX",726:"TX",737:"TX",806:"TX",817:"TX",830:"TX",832:"TX",903:"TX",915:"TX",936:"TX",940:"TX",945:"TX",956:"TX",972:"TX",979:"TX",
  // CA (examples)
  209:"CA",213:"CA",310:"CA",323:"CA",408:"CA",415:"CA",424:"CA",442:"CA",510:"CA",530:"CA",559:"CA",562:"CA",619:"CA",628:"CA",650:"CA",657:"CA",661:"CA",669:"CA",707:"CA",714:"CA",747:"CA",760:"CA",805:"CA",818:"CA",820:"CA",831:"CA",840:"CA",858:"CA",909:"CA",916:"CA",925:"CA",949:"CA",951:"CA"
  // ... keep the rest of your NPA map here ...
};

// State centroid lat/lon (approx)
const STATE_CENTROID = {
  AL:[32.806,-86.791], AK:[61.370,-152.404], AZ:[33.729,-111.431], AR:[34.970,-92.373],
  CA:[36.116,-119.681], CO:[39.059,-105.311], CT:[41.598,-72.755],  DC:[38.905,-77.017],
  DE:[39.318,-75.507],  FL:[27.766,-81.686],  GA:[33.040,-83.643],  HI:[21.094,-157.498],
  IA:[41.878,-93.097],  ID:[44.240,-114.478], IL:[40.349,-88.986],  IN:[39.849,-86.258],
  KS:[38.526,-96.726],  KY:[37.669,-84.651],  LA:[31.180,-91.874],  MA:[42.230,-71.530],
  MD:[39.063,-76.802],  ME:[44.693,-69.381],  MI:[43.327,-84.560],  MN:[45.694,-93.900],
  MO:[38.456,-92.289],  MS:[32.741,-89.678],  MT:[46.921,-110.454], NC:[35.630,-79.806],
  ND:[47.528,-99.784],  NE:[41.125,-98.269],  NH:[43.410,-71.655],  NJ:[40.298,-74.521],
  NM:[34.407,-106.112], NV:[38.313,-117.055], NY:[42.149,-74.938],  OH:[40.388,-82.764],
  OK:[35.565,-96.928],  OR:[43.804,-120.554], PA:[40.590,-77.210],  RI:[41.680,-71.511],
  SC:[33.856,-80.945],  SD:[44.299,-99.438],  TN:[35.747,-86.692],  TX:[31.054,-97.563],
  UT:[40.150,-111.862], VA:[37.769,-78.170],  VT:[44.045,-72.709],  WA:[47.400,-121.491],
  WI:[44.268,-89.616],  WV:[38.491,-80.955],  WY:[42.756,-107.302]
};

function distKm(a, b) {
  const R = 6371, toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function stateFromAreaCode(npa) {
  const k = Number(String(npa || "").replace(/\D+/g, ""));
  return NPA_STATE[k] || null;
}

function pickBestCallerId({ leadNPA, owned }) {
  const leadState = stateFromAreaCode(leadNPA);

  // 1) Exact NPA
  const exact = owned.find((x) => String(x.area_code) === String(leadNPA));
  if (exact) return exact.telnyx_number;

  // 2) Same state
  if (leadState) {
    const same = owned.find((x) => stateFromAreaCode(x.area_code) === leadState);
    if (same) return same.telnyx_number;
  }

  // 3) Closest state by centroid distance
  if (leadState && STATE_CENTROID[leadState]) {
    const leadPt = STATE_CENTROID[leadState];
    let best = null, bestD = Infinity;
    for (const row of owned) {
      const st = stateFromAreaCode(row.area_code);
      const pt = STATE_CENTROID[st];
      if (!st || !pt) continue;
      const d = distKm(leadPt, pt);
      if (d < bestD) { bestD = d; best = row; }
    }
    if (best) return best.telnyx_number;
  }

  // 4) Oldest owned number
  return owned[0]?.telnyx_number || null;
}

/* ------------------------------------------------------------------ */

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return bad(405, "Method Not Allowed");
  if (!TELNYX_API_KEY) return bad(500, "TELNYX_API_KEY missing");
  if (!CALL_CONTROL_APP_ID) return bad(500, "TELNYX_CALL_CONTROL_APP_ID missing");
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return bad(500, "Supabase server creds missing");

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch { return bad(400, "Invalid JSON"); }

  const agent_id     = String(body.agent_id || body.user_id || "").trim();
  const agent_number = String(body.agent_number || "").trim(); // we call this FIRST
  const lead_number  = String(body.lead_number  || "").trim(); // webhook will call AFTER agent answers
  const contact_id   = body.contact_id || null;

  if (!agent_id) return bad(422, "agent_id required");
  if (!isE164(agent_number)) return bad(422, "agent_number must be E.164");
  if (!isE164(lead_number)) return bad(422, "lead_number must be E.164");
  if (!lead_number.startsWith("+1")) return bad(422, "US numbers only (+1)");

  const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Owned numbers (oldest first)
  const { data: nums, error: listErr } = await supa
    .from("agent_numbers")
    .select("telnyx_number, area_code")
    .eq("agent_id", agent_id)
    .order("purchased_at", { ascending: true });

  if (listErr) return bad(500, "DB list error: " + listErr.message);
  if (!nums || nums.length === 0) return bad(400, "You don’t own any Telnyx numbers yet");

  // Recording preference
  let recordFlag = false;
  try {
    const { data: rec } = await supa
      .from("call_recording_settings")
      .select("record_outbound_enabled")
      .eq("user_id", agent_id)
      .maybeSingle();
    recordFlag = !!rec?.record_outbound_enabled;
  } catch {}

  // Pick best caller ID based on lead's area code
  const d = lead_number.replace(/\D+/g, "");
  const leadNPA = d.length >= 11 ? d.slice(1, 4) : (d.length === 10 ? d.slice(0, 3) : null);
  const callerId = pickBestCallerId({ leadNPA, owned: nums });
  if (!callerId) return bad(400, "Could not choose a caller ID");

  // Webhook-compatible client_state (keeps legacy keys)
  const client_state = b64({
    // legacy/new kinds so your webhook matches:
    kind: "crm_outbound_agent",            // ← old key you used before
    compat_kind: "crm_outbound_agent_leg", // ← alias if newer code expects this
    flow: "agent_first",

    // identities
    user_id: agent_id,
    agent_id,
    contact_id,

    // numbers (both legacy + new keys)
    lead_number,            // new
    to: lead_number,        // legacy alias
    from_number: callerId,  // new
    ani: callerId,          // legacy alias
    agent_number,

    // behavior flags (lead-first uses ringback; here mostly unused)
    ringback_url: RINGBACK_URL || null,
    b_timeout_secs: 25,
    record: recordFlag
  });

  // Create the AGENT leg FIRST
  const createPayload = {
    to: agent_number,
    from: callerId, // any owned DID; lead sees this caller ID when dialed by webhook
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

    // Do NOT speak here; the call isn't answered yet. Webhook speaks on call.answered (agent leg).
    return ok({ call_leg_id: j?.data?.call_leg_id || null });
  } catch (e) {
    return bad(500, e?.message || "Unexpected error");
  }
};
