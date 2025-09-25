// netlify/functions/call-start.js
// Dials the AGENT first, then your webhook transfers to the LEAD.
// Chooses Caller ID using local presence with geo fallbacks:
// 1) same area code, 2) same state, 3) neighboring states, 4) oldest.

const fetch = require("node-fetch");
const { createClient } = require("@supabase/supabase-js");

const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const CALL_CONTROL_APP_ID = process.env.TELNYX_CALL_CONTROL_APP_ID; // numeric ID

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;

const bad = (s, e, extra = {}) => ({
  statusCode: s,
  body: JSON.stringify({ ok: false, error: e, ...extra }),
});
const ok = (obj = { ok: true }) => ({
  statusCode: 200,
  body: JSON.stringify(obj),
});
const isE164 = (n) => /^\+\d{8,15}$/.test(String(n || "").trim());
const b64 = (o) => Buffer.from(JSON.stringify(o), "utf8").toString("base64");

/* --------------------- NPA → State (compact set) ----------------------
   This covers TN/GA/TX/AR/MO and nearby states commonly adjacent.
   If an area code isn’t in this map, we’ll treat state as unknown
   and fall back to oldest number.
----------------------------------------------------------------------- */
const NPA_STATE = {
  // Tennessee
  423: "TN", 615: "TN", 629: "TN", 731: "TN", 865: "TN", 901: "TN", 931: "TN",
  // Georgia
  229: "GA", 404: "GA", 470: "GA", 478: "GA", 678: "GA", 706: "GA", 762: "GA", 770: "GA", 912: "GA",
  // Texas
  210: "TX", 214: "TX", 254: "TX", 281: "TX", 325: "TX", 346: "TX", 361: "TX", 409: "TX", 430: "TX",
  432: "TX", 469: "TX", 512: "TX", 682: "TX", 713: "TX", 737: "TX", 806: "TX", 817: "TX", 830: "TX",
  832: "TX", 903: "TX", 915: "TX", 936: "TX", 940: "TX", 956: "TX", 972: "TX", 979: "TX",
  // Arkansas
  479: "AR", 501: "AR", 870: "AR",
  // Missouri
  314: "MO", 417: "MO", 557: "MO", 573: "MO", 636: "MO", 660: "MO", 816: "MO",
  // Alabama
  205: "AL", 251: "AL", 256: "AL", 334: "AL", 938: "AL",
  // Mississippi
  228: "MS", 601: "MS", 662: "MS", 769: "MS",
  // Kentucky
  270: "KY", 364: "KY", 502: "KY", 606: "KY", 859: "KY",
  // North Carolina
  252: "NC", 336: "NC", 704: "NC", 743: "NC", 828: "NC", 910: "NC", 919: "NC", 980: "NC", 984: "NC",
  // South Carolina
  803: "SC", 839: "SC", 843: "SC", 854: "SC", 864: "SC",
  // Florida
  305: "FL", 321: "FL", 324: "FL", 352: "FL", 386: "FL", 561: "FL", 645: "FL", 689: "FL",
  727: "FL", 754: "FL", 772: "FL", 786: "FL", 813: "FL", 850: "FL", 904: "FL", 941: "FL", 954: "FL",
  // Virginia
  276: "VA", 434: "VA", 540: "VA", 571: "VA", 703: "VA", 757: "VA", 804: "VA",
  // Oklahoma
  405: "OK", 539: "OK", 572: "OK", 580: "OK", 918: "OK",
  // Louisiana
  225: "LA", 318: "LA", 337: "LA", 504: "LA", 985: "LA",
  // New Mexico
  505: "NM", 575: "NM",
};

const STATE_NEIGHBORS = {
  TX: ["OK", "AR", "LA", "NM"],         // + (bordering Mexico not applicable)
  TN: ["KY", "VA", "NC", "GA", "AL", "MS", "AR", "MO"],
  GA: ["TN", "NC", "SC", "FL", "AL"],
  AR: ["MO", "TN", "MS", "LA", "TX", "OK"],
  MO: ["IA","IL","KY","TN","AR","OK","KS","NE"],
  AL: ["TN","GA","FL","MS"],
  MS: ["TN","AL","LA","AR"],
  KY: ["IL","IN","OH","WV","VA","TN","MO"],
  NC: ["VA","TN","GA","SC"],
  SC: ["NC","GA"],
  FL: ["AL","GA"],
  VA: ["MD","DC","NC","TN","KY","WV"],
  OK: ["KS","MO","AR","TX","NM","CO"],
  LA: ["TX","AR","MS"],
  NM: ["AZ","UT","CO","OK","TX"],
};

/** Return USPS 2-letter state for a NANP area code (string or number), or null. */
function stateFromAreaCode(npa) {
  const k = Number(String(npa || "").replace(/\D+/g, ""));
  return NPA_STATE[k] || null;
}

/** Decide best caller ID from owned numbers with geo fallback. */
function pickBestCallerId({ leadNPA, owned }) {
  // owned: [{ telnyx_number, area_code }]
  const leadState = stateFromAreaCode(leadNPA);

  // 1) Exact NPA match
  const exact = owned.find((x) => String(x.area_code) === String(leadNPA));
  if (exact) return exact.telnyx_number;

  // 2) Same state match
  if (leadState) {
    const sameState = owned.find((x) => stateFromAreaCode(x.area_code) === leadState);
    if (sameState) return sameState.telnyx_number;
  }

  // 3) Neighboring state match
  if (leadState && STATE_NEIGHBORS[leadState]) {
    const neighbors = STATE_NEIGHBORS[leadState];
    const neighborOwned = owned.find((x) =>
      neighbors.includes(stateFromAreaCode(x.area_code))
    );
    if (neighborOwned) return neighborOwned.telnyx_number;
  }

  // 4) Fallback to oldest number
  return owned[0]?.telnyx_number || null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return bad(405, "Method Not Allowed");
  if (!TELNYX_API_KEY) return bad(500, "TELNYX_API_KEY missing");
  if (!CALL_CONTROL_APP_ID) return bad(500, "TELNYX_CALL_CONTROL_APP_ID missing");
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY)
    return bad(500, "Supabase server creds missing");

  let body = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return bad(400, "Invalid JSON");
  }

  const agent_id = String(body.agent_id || body.user_id || "").trim();
  const agent_number = String(body.agent_number || "").trim(); // user's cell
  const lead_number = String(body.lead_number || "").trim();   // target
  const contact_id = body.contact_id || null;

  if (!agent_id) return bad(422, "agent_id required");
  if (!isE164(agent_number)) return bad(422, "agent_number must be E.164");
  if (!isE164(lead_number)) return bad(422, "lead_number must be E.164");

  const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Fetch the user's owned numbers (oldest first)
  const { data: nums, error: listErr } = await supa
    .from("agent_numbers")
    .select("telnyx_number, area_code")
    .eq("agent_id", agent_id)
    .order("purchased_at", { ascending: true });

  if (listErr) return bad(500, "DB list error: " + listErr.message);
  if (!nums || nums.length === 0)
    return bad(400, "You don’t own any Telnyx numbers yet");

  // Lead NPA (area code)
  const d = lead_number.replace(/\D+/g, "");
  const leadNPA = d.length >= 11 ? d.slice(1, 4) : (d.length === 10 ? d.slice(0, 3) : null);

  // Pick best Caller ID with geo fallback
  const callerId = pickBestCallerId({ leadNPA, owned: nums });
  if (!callerId) return bad(400, "Could not choose a caller ID");

  // Pass state in client_state for the webhook/analytics (optional)
  const client_state = b64({
    kind: "crm_outbound",
    user_id: agent_id,
    contact_id,
    lead_number,
    agent_number,
    from_number: callerId,
    // debug extras
    lead_npa: leadNPA,
    from_state: stateFromAreaCode(nums.find(n => n.telnyx_number === callerId)?.area_code),
    lead_state: stateFromAreaCode(leadNPA),
  });

  // ✅ Telnyx expects `connection_id` = your Call Control App ID
  const createPayload = {
    to: agent_number,                 // first leg = agent
    from: callerId,                   // your DID (local presence)
    connection_id: String(CALL_CONTROL_APP_ID),
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
      return bad(
        r.status,
        j?.errors?.[0]?.detail || j?.error || "Telnyx error",
        { telnyx_status: r.status, sent: { ...createPayload } }
      );
    }
    return ok({ call_leg_id: j?.data?.call_leg_id || null });
  } catch (e) {
    return bad(500, e?.message || "Unexpected error");
  }
};
