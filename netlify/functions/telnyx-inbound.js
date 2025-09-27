// File: netlify/functions/telnyx-inbound.js
// Inbound SMS → log message, honor STOP/START, pause sequences,
// lightweight AI reply: greet/identify, price pivot, spouse, wrong #,
// always push to quick call; confirm explicit times; 3 next-day slots (9a,1p,6p).

const { getServiceClient } = require("./_supabase");
const fetch = require("node-fetch");

function ok(body) {
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || { ok: true }),
  };
}

const norm10 = (s) => String(s || "").replace(/\D/g, "").slice(-10);
function toE164(p) {
  const d = String(p || "").replace(/\D/g, "");
  if (!d) return null;
  if (d.startsWith("1") && d.length === 11) return `+${d}`;
  if (d.length === 10) return `+1${d}`;
  if (String(p).startsWith("+")) return String(p);
  return null;
}

/* ===== Agent resolution (per-agent TFN → last sender → fallback) ===== */
async function resolveUserId(db, telnyxToE164) {
  const { data: owner } = await db
    .from("agent_messaging_numbers")
    .select("user_id")
    .eq("e164", telnyxToE164)
    .maybeSingle();
  if (owner?.user_id) return owner.user_id;

  const { data: m } = await db
    .from("messages")
    .select("user_id")
    .eq("from_number", telnyxToE164)
    .order("created_at", { ascending: false })
    .limit(1);
  if (m && m[0]?.user_id) return m[0].user_id;

  const SHARED =
    process.env.TELNYX_FROM ||
    process.env.TELNYX_FROM_NUMBER ||
    process.env.DEFAULT_FROM_NUMBER ||
    null;
  if (SHARED && SHARED === telnyxToE164) {
    // keep if you want special routing
  }
  return process.env.INBOUND_FALLBACK_USER_ID || process.env.DEFAULT_USER_ID || null;
}

/* ===== Contacts ===== */
async function findOrCreateContact(db, user_id, fromE164) {
  const last10 = norm10(fromE164);
  const { data, error } = await db
    .from("message_contacts")
    .select("id, phone, subscribed, ai_booked, full_name")
    .eq("user_id", user_id);
  if (error) throw error;

  const found = (data || []).find((c) => norm10(c.phone) === last10);
  if (found) return found;

  const ins = await db
    .from("message_contacts")
    .insert([{ user_id, phone: fromE164, subscribed: true, ai_booked: false }])
    .select("id, phone, subscribed, ai_booked, full_name")
    .maybeSingle();
  if (ins.error) throw ins.error;
  return ins.data;
}

/* ===== STOP/START ===== */
function parseKeyword(textIn) {
  const raw = String(textIn || "").trim();
  const normalized = raw.toUpperCase().replace(/[^A-Z]/g, "");
  const STOP_SET = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);
  const START_SET = new Set(["START", "YES", "UNSTOP"]);

  const treatNo = String(process.env.INBOUND_TREAT_NO_AS_STOP || "true").toLowerCase() === "true";
  if (treatNo && normalized === "NO") return "STOP";
  if (STOP_SET.has(normalized)) return "STOP";
  if (START_SET.has(normalized)) return "START";
  return null;
}

/* ===== Lead Rescue integration ===== */
async function stopLeadRescueOnReply(db, user_id, contact_id) {
  const now = new Date().toISOString();
  const { error } = await db
    .from("lead_rescue_trackers")
    .update({
      responded: true,
      paused: true,
      stop_reason: "responded",
      last_reply_at: now,
      responded_at: now,
    })
    .eq("user_id", user_id)
    .eq("contact_id", contact_id);
  if (error) throw error;
}

/* ===== AI helpers & config ===== */
const OUTBOUND_SEND_URL =
  process.env.OUTBOUND_SEND_URL ||
  (process.env.SITE_URL ? `${process.env.SITE_URL.replace(/\/$/, "")}/.netlify/functions/messages-send` : null);

const AGENT_TZ = process.env.AGENT_DEFAULT_TZ || "America/Chicago";
const WORK_START = 9;  // 9am
const WORK_END   = 21; // 9pm

function detectSpanish(text) {
  const t = String(text || "").toLowerCase();
  if (/[ñáéíóú¿¡]/.test(t)) return true;
  const hits = ["cuánto", "precio", "costo", "seguro", "vida", "mañana", "tarde", "quién", "número", "equivocado", "esposo", "esposa"];
  let score = 0;
  hits.forEach((w) => { if (t.includes(w)) score += 1; });
  return score >= 2;
}

function classifyIntent(txt) {
  const t = String(txt || "").trim().toLowerCase();

  if (!t) return "general";
  if (/\b(stop|unsubscribe|quit)\b/.test(t)) return "stop";

  // handle “who’s this” variants (contraction included) BEFORE anything else
  if (/\b(who\s*'?s\s*this|who is this|who dis)\b/.test(t) || /\bquién\b/.test(t)) return "who";

  if (/\b(^hi$|^hey$|^hello$|hola|buenas)\b/.test(t)) return "greeting";
  if (/\b(call me|llámame|llamame)\b/.test(t)) return "callme";
  if (/\b(price|how much|cost|monthly|cuánto|precio|costo)\b/.test(t)) return "price";
  if (/\b(already have|covered|ya tengo|tengo seguro)\b/.test(t)) return "covered";
  if (/\b(not interested|no me interesa|busy|ocupad[oa])\b/.test(t)) return "brushoff";
  if (/\b(wrong number|número equivocado)\b/.test(t)) return "wrong";
  if (/\b(spouse|wife|husband|espos[ao])\b/.test(t)) return "spouse";

  // time
  if (/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/.test(t) || /\bnoon\b/.test(t)) return "time_specific";
  if (/\b(tom|tomorrow|mañana|today|hoy|evening|afternoon|morning|tonight)\b/.test(t)) return "time_window";

  if (/^(ok|okay|sounds good|vale|bien|si|sí)\b/.test(t)) return "agree";
  return "general";
}

/** Day name (tomorrow) in TZ */
function nextDayName(tz) {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  return new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: tz }).format(tomorrow);
}

/** Fixed 3 next-day options (strings only; avoids TZ drift) */
function synthesizeThreeSlots(agentTZ) {
  const dayName = nextDayName(agentTZ || AGENT_TZ);
  return {
    dayName,
    slots: [{ label: "9:00 AM" }, { label: "1:00 PM" }, { label: "6:00 PM" }],
  };
}

/** Parse “10am”, “1:30 pm”, “noon”, or windows → return a friendly label clamped to 9–9 */
function parseRequestedTimeLabel(txt) {
  const t = String(txt || "").toLowerCase();

  if (/\bnoon\b/.test(t)) return "12:00 PM";

  const m = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  if (m) {
    let hh = parseInt(m[1], 10);
    const mm = m[2] ? parseInt(m[2], 10) : 0;
    const ap = m[3];
    if (ap === "pm" && hh !== 12) hh += 12;
    if (ap === "am" && hh === 12) hh = 0;

    if (hh < WORK_START) hh = WORK_START;
    if (hh > WORK_END)   hh = WORK_END;

    const hh12 = ((hh + 11) % 12) + 1;
    const apOut = hh >= 12 ? "PM" : "AM";
    const mmOut = (mm + "").padStart(2, "0");
    return `${hh12}:${mmOut} ${apOut}`;
  }

  if (/\bmorning\b/.test(t))   return "10:00 AM";
  if (/\bafternoon\b/.test(t)) return "2:00 PM";
  if (/\bevening\b|\btonight\b/.test(t)) return "6:00 PM";
  return null;
}

/* ====== Templates ====== */
function t_price(isEs, offer) {
  return isEs
    ? `Buena pregunta—el precio depende de su edad, salud y la cantidad de cobertura. Solo toma unos minutos en una llamada rápida para ver sus opciones exactas. Tengo ${offer}. ¿Cuál prefiere?`
    : `Good question—the price depends on your age, health, and coverage amount. It only takes a few minutes on a quick call to see your exact options. I have ${offer}. Which works best for you?`;
}
function t_covered(isEs, offer) {
  return isEs
    ? `Excelente. Aun así, muchas familias hacen una revisión rápida para no pagar de más ni perder beneficios. Solo toma unos minutos. Tengo ${offer}. ¿Cuál le conviene?`
    : `That’s great—you’re ahead of most people. Many families still do a quick review to make sure they’re not overpaying or missing benefits. It only takes a few minutes. I have ${offer}. Which is better for you?`;
}
function t_who(isEs, agentName, offer) {
  return isEs
    ? `Hola, soy ${agentName}. Usted solicitó información sobre seguros de vida y soy el corredor autorizado asignado para ayudarle. Podemos revisar sus opciones en pocos minutos—¿le funciona ${offer}?`
    : `Hey, it’s ${agentName}. You requested info about life insurance recently where you listed your beneficiary, and I’m the licensed broker assigned to follow up. We can go over your options in just a few minutes—would ${offer} work?`;
}
function t_brushoff(isEs, offer) {
  return isEs
    ? `Entiendo. Aun así, suele ser útil revisar opciones; toma solo unos minutos. Tengo ${offer}. ¿Cuál prefiere?`
    : `Totally understand—most people feel that way at first until they see how quick and straightforward it is. Let’s set aside a few minutes. I can do ${offer}. Which works better for you?`;
}
function t_callme(isEs) {
  return isEs
    ? `Claro—¿qué hora le conviene más? Puedo en la mañana o en la tarde.`
    : `Absolutely—what time works best for you? I can do mornings or evenings.`;
}
function t_spouse(isEs, offer) {
  return isEs
    ? `Totalmente de acuerdo—es la mejor forma. Programemos cuando puedan estar ambos. Tengo ${offer}. ¿Cuál funciona mejor para ustedes?`
    : `Totally understand—that’s the best way to do it. Let’s set a quick time when you can both be on. I have ${offer}. Which works better for you two?`;
}
function t_wrong(isEs) {
  return isEs
    ? `¡Disculpe la molestia! Ya que estamos—¿tiene su seguro de vida al día?`
    : `My apologies! Since I’ve got you—have you already got your life insurance taken care of?`;
}
function t_agree(isEs, offer) {
  return isEs
    ? `Perfecto—reserve unos minutos. Tengo ${offer}. ¿Cuál prefiere?`
    : `Great—let’s set aside a few minutes. I have ${offer}. Which works best for you?`;
}
function t_offer(dayName, slots) {
  const labels = slots.map(s => s.label);
  return `tomorrow (${dayName}) at ${labels[0]}, ${labels[1]}, or ${labels[2]}`;
}
function t_confirm(isEs, tsLabel, calendly) {
  const core = isEs
    ? `Perfecto, puedo a las ${tsLabel}. Mantendremos la llamada en unos minutos.`
    : `Yes, I can make ${tsLabel} work. We’ll keep it to just a few minutes.`;
  const link = calendly
    ? (isEs
        ? ` Aquí tiene un enlace rápido para confirmar y recibir recordatorios: ${calendly}`
        : ` Here’s a quick link to confirm so it’s locked in: ${calendly}`)
    : "";
  return core + link;
}

/* ===== DB helper ===== */
async function getAgentProfile(db, user_id) {
  const { data, error } = await db
    .from("agent_profiles")
    .select("full_name, calendly_url, email, phone")
    .eq("user_id", user_id)
    .maybeSingle();
  if (error) throw error;
  return data || {};
}

/* ===== Outbound via messages-send (with AI badge) ===== */
async function sendAI(db, { user_id, toE164, body, meta }) {
  if (!OUTBOUND_SEND_URL) {
    await db.from("messages").insert([{
      user_id, direction: "outgoing", provider:"system",
      from_number: "system", to_number: toE164,
      body: `[AI not sent: missing OUTBOUND_SEND_URL] ${body}`,
      status: "skipped", price_cents: 0, meta: { ...(meta||{}), sent_by_ai: true }, sent_by_ai: true
    }]);
    return { ok: false, skipped: true, reason: "no_outbound_url" };
  }

  const res = await fetch(OUTBOUND_SEND_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      to: toE164,
      body,
      requesterId: user_id,
      sent_by_ai: true,
    }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok || out?.error) {
    await db.from("messages").insert([{
      user_id, direction:"outgoing", provider:"system", from_number:"system", to_number:toE164,
      body:`[AI send failed] ${body}`, status:"error", price_cents:0,
      meta: { ...(meta||{}), sent_by_ai:true, error: out?.error || res.status },
      sent_by_ai: true,
    }]);
    return { ok: false, error: out?.error || `status_${res.status}` };
  }
  return { ok: true, ...out };
}

/* ===== Handler ===== */
exports.handler = async (event) => {
  const db = getServiceClient();

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}

  const data = body.data || body;
  const payload = data.payload || data;

  const providerSid = payload?.id || data?.id || null;
  const from = toE164(payload?.from?.phone_number || payload?.from || "");
  const to   = toE164((Array.isArray(payload?.to) && payload.to[0]?.phone_number) || payload?.to || "");
  const text = String(payload?.text || payload?.body || "").trim();

  if (!providerSid || !from || !to) return ok({ ok: true, note: "missing_fields" });

  // Dedupe on provider+sid
  const { data: dupe } = await db
    .from("messages")
    .select("id")
    .eq("provider", "telnyx")
    .eq("provider_sid", providerSid)
    .limit(1);
  if (dupe && dupe.length) return ok({ ok: true, deduped: true });

  const user_id = await resolveUserId(db, to);
  if (!user_id) return ok({ ok: false, error: "no_user_for_number", to });

  // Ensure a contact exists
  const contact = await findOrCreateContact(db, user_id, from);

  // Insert inbound
  const row = {
    user_id,
    contact_id: contact?.id || null,
    direction: "incoming",
    provider: "telnyx",
    from_number: from,
    to_number: to,
    body: text,
    status: "received",
    provider_sid: providerSid,
    price_cents: 0,
  };
  const ins = await db.from("messages").insert([row]);
  if (ins.error) return ok({ ok: false, error: ins.error.message });

  // Pause Lead Rescue
  try { await stopLeadRescueOnReply(db, user_id, contact.id); } catch {}

  // STOP/START
  const action = parseKeyword(text);
  if (action === "STOP") {
    await db.from("message_contacts").update({ subscribed: false }).eq("id", contact.id);
    return ok({ ok: true, action: "unsubscribed" });
  }
  if (action === "START") {
    await db.from("message_contacts").update({ subscribed: true }).eq("id", contact.id);
    return ok({ ok: true, action: "resubscribed" });
  }

  // Respect unsubscribed / booked
  if (contact.subscribed === false) return ok({ ok: true, note: "contact_unsubscribed" });
  if (contact.ai_booked === true)   return ok({ ok: true, note: "ai_silent_booked" });

  // Context for replies
  const agent = await getAgentProfile(db, user_id);
  const calendlyLink = agent?.calendly_url || "";
  const { dayName, slots } = synthesizeThreeSlots(AGENT_TZ);
  const offerText = t_offer(dayName, slots);
  const isEs = detectSpanish(text);
  const intent = classifyIntent(text);

  async function send(bodyText, meta) {
    return await sendAI(db, { user_id, toE164: from, body: bodyText, meta });
  }

  // Specific time or window
  if (intent === "time_specific" || intent === "time_window") {
    const requestedLabel = parseRequestedTimeLabel(text); // e.g., "10:00 AM"
    if (requestedLabel) {
      await send(t_confirm(isEs, requestedLabel, calendlyLink), { ai_intent: "confirm_time" });
      await db.from("message_contacts").update({ ai_booked: true }).eq("id", contact.id);
      return ok({ ok: true, ai: "confirmed_and_linked" });
    }
    await send(t_agree(isEs, offerText), { ai_intent: "offer_slots_after_time_window" });
    return ok({ ok: true, ai: "offered_slots" });
  }

  // Natural greeting
  if (intent === "greeting") {
    const name = agent?.full_name || "your licensed broker";
    const msg = isEs
      ? `¡Hola! Soy ${name}. Podemos revisar sus opciones en unos minutos — ¿le funciona ${offerText}?`
      : `Hey there—it’s ${name}. We can go over your options in just a few minutes — would ${offerText} work?`;
    await send(msg, { ai_intent: "greeting" });
    return ok({ ok: true, ai: "greeted" });
  }

  // Identity
  if (intent === "who") {
    await send(t_who(isEs, agent?.full_name || "your licensed broker", offerText), { ai_intent: "who" });
    return ok({ ok: true, ai: "who" });
  }

  // Price pivot
  if (intent === "price") {
    await send(t_price(isEs, offerText), { ai_intent: "price" });
    return ok({ ok: true, ai: "price" });
  }

  // Other branches
  if (intent === "covered") {
    await send(t_covered(isEs, offerText), { ai_intent: "covered" });
    return ok({ ok: true, ai: "covered" });
  }
  if (intent === "brushoff") {
    await send(t_brushoff(isEs, offerText), { ai_intent: "brushoff" });
    return ok({ ok: true, ai: "brushoff" });
  }
  if (intent === "wrong") {
    await send(t_wrong(isEs), { ai_intent: "wrong" });
    return ok({ ok: true, ai: "wrong" });
  }
  if (intent === "spouse") {
    await send(t_spouse(isEs, offerText), { ai_intent: "spouse" });
    return ok({ ok: true, ai: "spouse" });
  }
  if (intent === "callme" || intent === "agree") {
    await send(t_callme(isEs), { ai_intent: "callme_or_agree" });
    return ok({ ok: true, ai: "callme_or_agree" });
  }

  // Fallback
  await send(t_agree(isEs, offerText), { ai_intent: "offer_slots_fallback" });
  return ok({ ok: true, ai: "responded" });
};