// netlify/functions/call-start.js
// Dials the AGENT first from one of THEIR Telnyx DIDs.
// Chooses caller ID with priority: exact NPA -> same state -> neighboring state -> same timezone -> first purchased.
// Uses Telnyx Call Control Application via `connection_id`.

const fetch = require("node-fetch");
const { createClient } = require("@supabase/supabase-js");

const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const CALL_CONTROL_APP_ID = process.env.TELNYX_CALL_CONTROL_APP_ID; // numeric ID
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;

/* ---------- Helpers: state + area-code maps (focused on South/Central + TX/MO/IL/IN/VA/NC/SC/FL) ---------- */
// Area code -> US state (2-letter). Not exhaustive; covers your region + TX + neighbors.
// If a code is missing, we gracefully fall back to default selection.
const AREA_TO_STATE = {
  // Tennessee
  "423":"TN","615":"TN","629":"TN","731":"TN","901":"TN",
  // Georgia
  "229":"GA","404":"GA","470":"GA","478":"GA","678":"GA","706":"GA","762":"GA","770":"GA","912":"GA",
  // Texas
  "210":"TX","214":"TX","254":"TX","281":"TX","325":"TX","346":"TX","361":"TX","409":"TX","430":"TX","432":"TX",
  "469":"TX","512":"TX","682":"TX","713":"TX","726":"TX","737":"TX","806":"TX","817":"TX","830":"TX","832":"TX",
  "903":"TX","915":"TX","936":"TX","940":"TX","945":"TX","956":"TX","972":"TX","979":"TX",
  // Arkansas
  "479":"AR","501":"AR","870":"AR",
  // Missouri
  "314":"MO","417":"MO","557":"MO","573":"MO","636":"MO","660":"MO","816":"MO",
  // Alabama
  "205":"AL","251":"AL","256":"AL","334":"AL","938":"AL",
  // Mississippi
  "228":"MS","601":"MS","662":"MS","769":"MS",
  // Kentucky
  "270":"KY","364":"KY","502":"KY","606":"KY","859":"KY",
  // North Carolina
  "252":"NC","336":"NC","704":"NC","743":"NC","910":"NC","919":"NC","980":"NC","984":"NC",
  // South Carolina
  "803":"SC","843":"SC","854":"SC","864":"SC",
  // Florida (lots—common for your leads)
  "239":"FL","305":"FL","321":"FL","352":"FL","386":"FL","407":"FL","448":"FL","561":"FL","645":"FL","689":"FL",
  "727":"FL","754":"FL","772":"FL","786":"FL","813":"FL","850":"FL","863":"FL","904":"FL","941":"FL","954":"FL",
  // Oklahoma
  "405":"OK","539":"OK","572":"OK","580":"OK","918":"OK",
  // Louisiana
  "225":"LA","318":"LA","337":"LA","504":"LA","985":"LA",
  // Virginia
  "276":"VA","434":"VA","540":"VA","571":"VA","703":"VA","757":"VA","804":"VA",
  // Illinois
  "217":"IL","224":"IL","309":"IL","312":"IL","331":"IL","447":"IL","464":"IL","618":"IL","630":"IL",
  "708":"IL","730":"IL","773":"IL","779":"IL","815":"IL","847":"IL","872":"IL",
  // Indiana
  "219":"IN","260":"IN","317":"IN","463":"IN","574":"IN","765":"IN","812":"IN","930":"IN"
};

// State adjacency (subset; enough for good “closest” picks around your region)
const ADJ_STATES = {
  TX: ["NM","OK","AR","LA"],
  TN: ["KY","VA","NC","GA","AL","MS","AR","MO"],
  GA: ["TN","NC","SC","FL","AL"],
  AR: ["MO","TN","MS","LA","TX","OK"],
  MO: ["IA","IL","KY","TN","AR","OK","KS","NE"],
  AL: ["TN","GA","FL","MS"],
  MS: ["TN","AL","LA","AR"],
  KY: ["IL","IN","OH","WV","VA","TN","MO"],
  NC: ["VA","TN","GA","SC"],
  SC: ["NC","GA"],
  FL: ["AL","GA"],
  OK: ["KS","CO","NM","TX","AR","MO"],
  LA: ["TX","AR","MS"],
  VA: ["MD","DC","NC","TN","KY","WV"],
  IL: ["WI","IA","MO","KY","IN","MI"],
  IN: ["MI","OH","KY","IL"]
};

// State -> coarse time zone
const STATE_TZ = {
  CT: ["AL","AR","IL","IN","KY","LA","MS","MO","OK","TN","TX"], // treating IN/KY as CT here when helpful in your region
  ET: ["FL","GA","NC","SC","VA"],
  // (we can expand if you start using Mountain/Pacific)
};

function stateOfAreaCode(npa) { return AREA_TO_STATE[npa] || null; }
function tzOfState(st) {
  if (!st) return null;
  if (STATE_TZ.ET.includes(st)) return "ET";
  if (STATE_TZ.CT.includes(st)) return "CT";
  return null;
}

const bad = (s, e, extra = {}) => ({ statusCode: s, body: JSON.stringify({ ok: false, error: e, ...extra }) });
const ok = (obj = { ok: true }) => ({ statusCode: 200, body: JSON.stringify(obj) });
const isE164 = (n) => /^\+\d{8,15}$/.test(String(n || "").trim());
const b64 = (o) => Buffer.from(JSON.stringify(o), "utf8").toString("base64");

/* ---------- Choose best caller ID ---------- */
function chooseBestCallerId({ leadArea, leadState, myNums }) {
  // 1) Exact area-code match
  const exact = myNums.find(n => n.area_code === leadArea);
  if (exact) return exact.telnyx_number;

  // 2) Same state
  if (leadState) {
    const sameState = myNums.find(n => stateOfAreaCode(n.area_code) === leadState);
    if (sameState) return sameState.telnyx_number;
  }

  // 3) Neighboring state
  if (leadState && ADJ_STATES[leadState]) {
    const neighbors = new Set(ADJ_STATES[leadState]);
    const neighborPick = myNums.find(n => neighbors.has(stateOfAreaCode(n.area_code)));
    if (neighborPick) return neighborPick.telnyx_number;
  }

  // 4) Same timezone (ET/CT) as a coarse fallback
  const leadTz = tzOfState(leadState);
  if (leadTz) {
    const tzPick = myNums.find(n => tzOfState(stateOfAreaCode(n.area_code)) === leadTz);
    if (tzPick) return tzPick.telnyx_number;
  }

  // 5) Final fallback: first purchased (already ordered ASC in query)
  return myNums[0]?.telnyx_number;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return bad(405, "Method Not Allowed");
  if (!TELNYX_API_KEY) return bad(500, "TELNYX_API_KEY missing");
  if (!CALL_CONTROL_APP_ID) return bad(500, "TELNYX_CALL_CONTROL_APP_ID missing");
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return bad(500, "Supabase server creds missing");

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch { return bad(400, "Invalid JSON"); }

  const agent_id = String(body.agent_id || body.user_id || "").trim();
  const agent_number = String(body.agent_number || "").trim(); // agent's cell
  const lead_number = String(body.lead_number || "").trim();   // target
  const contact_id = body.contact_id || null;

  if (!agent_id) return bad(422, "agent_id required");
  if (!isE164(agent_number)) return bad(422, "agent_number must be E.164");
  if (!isE164(lead_number)) return bad(422, "lead_number must be E.164");

  const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Load the user's owned numbers (ASC so first = oldest for fallback)
  const { data: nums, error: listErr } = await supa
    .from("agent_numbers")
    .select("telnyx_number, area_code")
    .eq("agent_id", agent_id)
    .order("purchased_at", { ascending: true });

  if (listErr) return bad(500, "DB list error: " + listErr.message);
  if (!nums || nums.length === 0) return bad(400, "You don’t own any Telnyx numbers yet");

  const digits = lead_number.replace(/\D+/g, "");
  const leadArea = digits.length >= 11 ? digits.slice(1, 4) : digits.slice(0, 3);
  const leadState = stateOfAreaCode(leadArea);

  const callerId = chooseBestCallerId({ leadArea, leadState, myNums: nums });

  const client_state = b64({
    kind: "crm_outbound",
    user_id: agent_id,
    contact_id,
    lead_number,
    agent_number,
    from_number: callerId,
    lead_area: leadArea,
    lead_state: leadState
  });

  const createPayload = {
    to: agent_number,
    from: callerId,
    connection_id: String(CALL_CONTROL_APP_ID),
    client_state,
    timeout_secs: 45
  };

  try {
    const r = await fetch("https://api.telnyx.com/v2/calls", {
      method: "POST",
      headers: { Authorization: `Bearer ${TELNYX_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(createPayload)
    });
    const j
