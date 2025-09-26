// netlify/functions/call-start.js
// Agent leg first, then your webhook transfers to the lead.
// Caller ID selection priority:
// 1) Exact area code (NPA) match
// 2) Same state as the lead
// 3) Geographically closest state (by centroid distance)
// 4) Oldest owned number

const fetch = require("node-fetch");
const { createClient } = require("@supabase/supabase-js");

const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const CALL_CONTROL_APP_ID = process.env.TELNYX_CALL_CONTROL_APP_ID;
// Optional ringback audio while B-leg is dialing (MP3/WAV URL). Safe to leave blank.
const RINGBACK_URL = process.env.RINGBACK_URL || "";

// You already have one of these set in Netlify; support both env names.
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

/**
 * --- US state centroids (approx) ---
 * Used to pick the geographically closest *owned* state when no same-state match exists.
 * Source: standard public centroid lists; approximate is fine for “closest” decisions.
 */
const STATE_CENTROID = {
  AL:[32.806, -86.791], AK:[61.370, -152.404], AZ:[33.729, -111.431], AR:[34.970, -92.373],
  CA:[36.116, -119.681], CO:[39.059, -105.311], CT:[41.598, -72.755],  DC:[38.905, -77.017],
  DE:[39.318, -75.507],  FL:[27.766, -81.686],  GA:[33.040, -83.643],  HI:[21.094, -157.498],
  IA:[41.878, -93.097],  ID:[44.240, -114.478], IL:[40.349, -88.986],  IN:[39.849, -86.258],
  KS:[38.526, -96.726],  KY:[37.669, -84.651],  LA:[31.180, -91.874],  MA:[42.230, -71.530],
  MD:[39.063, -76.802],  ME:[44.693, -69.381],  MI:[43.327, -84.560],  MN:[45.694, -93.900],
  MO:[38.456, -92.289],  MS:[32.741, -89.678],  MT:[46.921, -110.454], NC:[35.630, -79.806],
  ND:[47.528, -99.784],  NE:[41.125, -98.269],  NH:[43.410, -71.655],  NJ:[40.298, -74.521],
  NM:[34.407, -106.112], NV:[38.313, -117.055], NY:[42.149, -74.938],  OH:[40.388, -82.764],
  OK:[35.565, -96.928],  OR:[43.804, -120.554], PA:[40.590, -77.210],  RI:[41.680, -71.511],
  SC:[33.856, -80.945],  SD:[44.299, -99.438],  TN:[35.747, -86.692],  TX:[31.054, -97.563],
  UT:[40.150, -111.862], VA:[37.769, -78.170],  VT:[44.045, -72.709],  WA:[47.400, -121.491],
  WI:[44.268, -89.616],  WV:[38.491, -80.955],  WY:[42.756, -107.302]
};

/**
 * --- US NPA → USPS two-letter state map (United States only) ---
 * Comprehensive set as of 2025. Overlays share the same state as the parent NPA.
 */
const NPA_STATE = {
  // AL
  205:"AL",251:"AL",256:"AL",334:"AL",938:"AL",
  // AK
  907:"AK",
  // AZ
  480:"AZ",520:"AZ",602:"AZ",623:"AZ",928:"AZ",
  // AR
  479:"AR",501:"AR",870:"AR",
  // CA
  209:"CA",213:"CA",279:"CA",310:"CA",341:"CA",350:"CA",369:"CA",408:"CA",415:"CA",424:"CA",
  442:"CA",447:"CA",510:"CA",530:"CA",559:"CA",562:"CA",619:"CA",628:"CA",650:"CA",657:"CA",
  661:"CA",669:"CA",707:"CA",714:"CA",747:"CA",760:"CA",805:"CA",818:"CA",820:"CA",831:"CA",
  840:"CA",858:"CA",909:"CA",916:"CA",925:"CA",949:"CA",951:"CA",
  // CO
  303:"CO",719:"CO",720:"CO",970:"CO",983:"CO",
  // CT
  203:"CT",475:"CT",860:"CT",959:"CT",
  // DC
  202:"DC",771:"DC",
  // DE
  302:"DE",
  // FL
  305:"FL",321:"FL",324:"FL",352:"FL",386:"FL",407:"FL",448:"FL",561:"FL",645:"FL",689:"FL",
  727:"FL",754:"FL",772:"FL",786:"FL",813:"FL",850:"FL",904:"FL",941:"FL",954:"FL",
  // GA
  229:"GA",404:"GA",470:"GA",478:"GA",678:"GA",706:"GA",762:"GA",770:"GA",912:"GA",
  // HI
  808:"HI",
  // ID
  208:"ID",986:"ID",
  // IL
  217:"IL",224:"IL",309:"IL",331:"IL",447:"IL",464:"IL",618:"IL",630:"IL",708:"IL",730:"IL",
  773:"IL",779:"IL",815:"IL",847:"IL",872:"IL",
  // IN
  219:"IN",260:"IN",317:"IN",463:"IN",574:"IN",765:"IN",812:"IN",930:"IN",
  // IA
  319:"IA",515:"IA",563:"IA",641:"IA",712:"IA",
  // KS
  316:"KS",620:"KS",785:"KS",913:"KS",
  // KY
  270:"KY",364:"KY",502:"KY",606:"KY",859:"KY",
  // LA
  225:"LA",318:"LA",337:"LA",504:"LA",985:"LA",
  // ME
  207:"ME",
  // MD
  227:"MD",240:"MD",301:"MD",410:"MD",443:"MD",667:"MD",
  // MA
  339:"MA",351:"MA",413:"MA",508:"MA",617:"MA",774:"MA",781:"MA",857:"MA",978:"MA",
  // MI
  231:"MI",248:"MI",269:"MI",313:"MI",517:"MI",586:"MI",616:"MI",679:"MI",734:"MI",810:"MI",
  906:"MI",947:"MI",989:"MI",
  // MN
  218:"MN",320:"MN",507:"MN",612:"MN",651:"MN",763:"MN",952:"MN",
  // MS
  228:"MS",601:"MS",662:"MS",769:"MS",
  // MO
  314:"MO",417:"MO",557:"MO",573:"MO",636:"MO",660:"MO",816:"MO",
  // MT
  406:"MT",
  // NC
  252:"NC",336:"NC",704:"NC",743:"NC",828:"NC",910:"NC",919:"NC",980:"NC",984:"NC",
  // ND
  701:"ND",
  // NE
  308:"NE",402:"NE",531:"NE",
  // NH
  603:"NH",
  // NJ
  201:"NJ",551:"NJ",609:"NJ",640:"NJ",732:"NJ",848:"NJ",856:"NJ",862:"NJ",908:"NJ",973:"NJ",
  // NM
  505:"NM",575:"NM",
  // NV
  702:"NV",725:"NV",775:"NV",
  // NY
  212:"NY",315:"NY",329:"NY",332:"NY",347:"NY",363:"NY",516:"NY",518:"NY",585:"NY",607:"NY",
  631:"NY",646:"NY",680:"NY",683:"NY",716:"NY",718:"NY",838:"NY",845:"NY",914:"NY",917:"NY",
  929:"NY",934:"NY",
  // OH
  216:"OH",220:"OH",234:"OH",283:"OH",326:"OH",330:"OH",380:"OH",419:"OH",427:"OH",440:"OH",
  513:"OH",567:"OH",614:"OH",740:"OH",937:"OH",
  // OK
  405:"OK",539:"OK",572:"OK",580:"OK",918:"OK",
  // OR
  458:"OR",503:"OR",541:"OR",971:"OR",
  // PA
  215:"PA",223:"PA",267:"PA",272:"PA",302:"PA",412:"PA",445:"PA",484:"PA",570:"PA",582:"PA",
  610:"PA",628:"PA",717:"PA",724:"PA",814:"PA",835:"PA",878:"PA",
  // RI
  401:"RI",
  // SC
  803:"SC",839:"SC",843:"SC",854:"SC",864:"SC",
  // SD
  605:"SD",
  // TN
  423:"TN",615:"TN",629:"TN",731:"TN",865:"TN",901:"TN",931:"TN",
  // TX
  210:"TX",214:"TX",254:"TX",281:"TX",325:"TX",346:"TX",361:"TX",409:"TX",430:"TX",432:"TX",
  469:"TX",512:"TX",682:"TX",713:"TX",726:"TX",737:"TX",806:"TX",817:"TX",830:"TX",832:"TX",
  903:"TX",915:"TX",936:"TX",940:"TX",945:"TX",956:"TX",972:"TX",979:"TX",
  // UT
  385:"UT",435:"UT",801:"UT",
  // VA
  276:"VA",434:"VA",540:"VA",571:"VA",703:"VA",757:"VA",804:"VA",
  // VT
  802:"VT",
  // WA
  206:"WA",253:"WA",360:"WA",425:"WA",509:"WA",564:"WA",
  // WI
  262:"WI",274:"WI",334:"WI",414:"WI",534:"WI",608:"WI",715:"WI",920:"WI",
  // WV
  304:"WV",681:"WV",
  // WY
  307:"WY"
};

/** Haversine distance (km) between two [lat,lon] points. */
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

/** Decide best caller ID with geo fallback. */
function pickBestCallerId({ leadNPA, owned }) {
  // owned: [{ telnyx_number, area_code }]
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

  // 4) Oldest
  return owned[0]?.telnyx_number || null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return bad(405, "Method Not Allowed");
  if (!TELNYX_API_KEY) return bad(500, "TELNYX_API_KEY missing");
  if (!CALL_CONTROL_APP_ID) return bad(500, "TELNYX_CALL_CONTROL_APP_ID missing");
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY)
    return bad(500, "Supabase server creds missing");

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch { return bad(400, "Invalid JSON"); }

  const agent_id = String(body.agent_id || body.user_id || "").trim();
  const agent_number = String(body.agent_number || "").trim(); // agent cell
  const lead_number = String(body.lead_number || "").trim();   // target
  const contact_id = body.contact_id || null;

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

  // Read the per-user recording preference from the new table
  let recordFlag = false;
  try {
    const { data: rec } = await supa
      .from("call_recording_settings")
      .select("record_outbound_enabled")
      .eq("user_id", agent_id)
      .maybeSingle();
    recordFlag = !!rec?.record_outbound_enabled;
  } catch {}

  // Lead NPA (area code)
  const d = lead_number.replace(/\D+/g, "");
  const leadNPA = d.length >= 11 ? d.slice(1, 4) : (d.length === 10 ? d.slice(0, 3) : null);

  const callerId = pickBestCallerId({ leadNPA, owned: nums });
  if (!callerId) return bad(400, "Could not choose a caller ID");

  // Client state tells the webhook what to do next (ringback/timeout/recording)
  const client_state = b64({
    kind: "crm_outbound",
    user_id: agent_id,
    contact_id,
    lead_number,
    agent_number,
    from_number: callerId,
    lead_npa: leadNPA,
    lead_state: stateFromAreaCode(leadNPA),
    ringback_url: RINGBACK_URL || null, // optional; webhook will skip if null/empty
    b_timeout_secs: 25,                  // dial B-leg for up to ~25s, then bail
    record: recordFlag                   // 🔑 enable recording (webhook will start + bill 2¢)
  });

  const createPayload = {
    to: agent_number,
    from: callerId,
    connection_id: String(CALL_CONTROL_APP_ID),
    client_state,
    timeout_secs: 45,
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
    return ok({ call_leg_id: j?.data?.call_leg_id || null });
  } catch (e) {
    return bad(500, e?.message || "Unexpected error");
  }
};
