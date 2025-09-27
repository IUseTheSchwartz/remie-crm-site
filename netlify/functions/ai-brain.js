// Pure response logic: language, intent, slots, copy.
// Exports: decide({ text, agentName, calendlyLink, tz, officeHours }) -> { text, intent }

const DEFAULT_TZ = "America/Chicago";
const DEFAULT_HOURS = { start: 9, end: 21 }; // inclusive local window

/* ---------------- Language detection ---------------- */
function detectSpanish(t = "") {
  const s = String(t).toLowerCase();
  if (/[ñáéíóúü¿¡]/.test(s)) return true;
  const esHints = [
    "cuánto","cuanto","precio","costo","seguro","vida","mañana","manana",
    "tarde","noche","quien","quién","numero","número","equivocado","esposo","esposa",
    "si","sí","vale","claro","buenas","hola",
  ];
  let score = 0; for (const w of esHints) if (s.includes(w)) score++;
  return score >= 2;
}

/* ---------------- Intent classification (robust) ---------------- */
function normalize(t = "") { return String(t).trim().toLowerCase().replace(/\s+/g, " "); }

function classify(t = "") {
  const x = normalize(t);

  if (!x) return "general";

  // super short acks
  if (/^(k|kk|kay|ok(ay)?|y+|ya|ye+a?h?|si|sí|dale|va|vale|bet|sounds good|cool|alr|alright)\b/.test(x)) return "agree";
  if (/^(nah|nope|no)\b/.test(x)) return "brushoff";

  // unsubscribe signal (handled upstream)
  if (/\b(stop|unsubscribe|quit|cancel)\b/.test(x)) return "stop";

  // price
  if (/\b(price|how much|cost|monthly|payment|premium|quote|rates?)\b/.test(x) ||
      /\b(cu[áa]nto|precio|costo|pago|mensual|cuota|prima)\b/.test(x)) return "price";

  // who / provenance (covers "who's/whos/who is this")
  if (/\b(who('?|’)?s|whos)\s+this\??\b/.test(x) ||
      /\bwho\s+is\s+this\??\b/.test(x) ||
      /\bhow did you get\b/.test(x) ||
      /\bwhy (are|r) you texting\b/.test(x) ||
      /\bqui[eé]n (eres|habla|manda|me escribe)\b/.test(x)) return "who";

  // covered already
  if (/\b(already have|i have insurance|covered|i'm covered|policy already)\b/.test(x) ||
      /\b(ya tengo|tengo seguro|ya estoy cubiert[oa])\b/.test(x)) return "covered";

  // busy / brush-off
  if (/\b(not interested|stop texting|leave me alone|busy|working|at work|later|another time)\b/.test(x) ||
      /\b(no me interesa|ocupad[oa]|luego|m[aá]s tarde|otro d[ií]a)\b/.test(x)) return "brushoff";

  // wrong number
  if (/\bwrong number|not (me|my number)\b/.test(x) || /\bn[uú]mero equivocado\b/.test(x)) return "wrong";

  // spouse / both on call
  if (/\b(spouse|wife|husband|partner)\b/.test(x) || /\bespos[ao]\b/.test(x)) return "spouse";

  // explicit call me
  if (/\b(call|ring|phone me|give me a call|ll[aá]mame|llamar)\b/.test(x)) return "callme";

  // reschedule / different time
  if (/\b(resched|re[- ]?schedule|different time|change (the )?time|move (it|appt)|new time)\b/i.test(x) ||
      /\b(reprogramar|cambiar hora|otra hora|mover la cita)\b/.test(x)) return "reschedule";

  // time windows
  if (/\b(tom(orrow)?|today|evening|afternoon|morning|tonight|this (afternoon|evening|morning))\b/.test(x) ||
      /\b(ma[ñn]ana|hoy|tarde|noche)\b/.test(x)) return "time_window";

  // explicit clock time “10”, “10am”, “10:30 pm”, “10:30”
  if (/\b(1?\d(?::\d{2})?\s?(a\.?m\.?|p\.?m\.?|am|pm))\b/.test(x) || /\b(1?\d:\d{2})\b/.test(x)) return "time_specific";

  // greetings
  if (/^(hi|hey|hello|hola|buenas)\b/.test(x)) return "greet";

  return "general";
}

/* ---------------- Time helpers: label-only (no Date math for slot labels) ---------------- */
function getLocalHour24(tz = DEFAULT_TZ) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour: "numeric", minute: "numeric", hour12: true
  }).formatToParts(new Date()).reduce((a, p) => (a[p.type] = p.value, a), {});
  let h = parseInt(parts.hour, 10);
  const period = (parts.dayPeriod || parts.dayperiod || "").toLowerCase();
  if (period === "pm" && h < 12) h += 12;
  if (period === "am" && h === 12) h = 0;
  return h; // 0–23
}

function clampSlotHours(baseHours, window) {
  const uniq = [...new Set(baseHours.map(h => Math.round(h)))];
  return uniq
    .map(h => Math.min(Math.max(h, window.start), window.end))
    .filter(h => h >= window.start && h <= window.end);
}

function fmtHour12(h, min = 0) {
  const hour12 = ((h + 11) % 12) + 1;
  const ampm = h < 12 ? "AM" : "PM";
  const mm = String(min).padStart(2, "0");
  return `${hour12}:${mm} ${ampm}`;
}

/** Build slot strings without constructing Date objects; anchors 8, 13, 18 (8a / 1p / 6p) */
function synthesizeSlots({ tz = DEFAULT_TZ, hours = DEFAULT_HOURS, basePicks = [8, 13, 18] } = {}) {
  const nowH = getLocalHour24(tz);
  const sameDay = nowH <= (hours.end - 2); // need 2h buffer
  let picks = clampSlotHours(basePicks, hours);
  if (!picks.length) {
    picks = clampSlotHours([hours.start, hours.start + 2, Math.min(hours.end, hours.start + 8)], hours);
  }
  const labels = picks.slice(0, 3).map(h => fmtHour12(h, 0));

  // If not same-day, compute tomorrow's weekday for clarity (simple +24h; TZ only for naming)
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: tz }).format(tomorrow);
  const dayWord = sameDay ? "" : ` (${weekday})`;

  return { sameDay, dayWord, slots: labels };
}

function offerTxt(dayWord, slots) {
  if (!slots.length) return "a quick time that works for you";
  if (slots.length === 1) return `${slots[0]}${dayWord}`;
  if (slots.length === 2) return `${slots[0]} or ${slots[1]}${dayWord}`;
  return `${slots[0]}, ${slots[1]}, or ${slots[2]}${dayWord}`;
}

/* ---------------- Copy templates ---------------- */
const T = {
  greet: (es, n, offer) =>
    es ? `Hola—soy ${n}. ¿Le funciona ${offer}?`
       : `Hey there—it’s ${n}. Would ${offer} work?`,
  who: (es, n, offer) =>
    es ? `Hola, soy ${n}. Usted solicitó información de seguro de vida. Podemos verlo en unos minutos—¿le funciona ${offer}?`
       : `Hey, it’s ${n}. You requested info about life insurance recently where you listed your beneficiary. We can go over options in just a few minutes—would ${offer} work?`,
  price: (es, offer) =>
    es ? `Buena pregunta—el precio depende de edad, salud y cobertura. Lo vemos en una llamada corta. Tengo ${offer}. ¿Cuál prefiere?`
       : `Great question—price depends on age, health, and coverage. We’ll nail it on a quick call. I have ${offer}. Which works best?`,
  covered: (es, offer) =>
    es ? `Excelente. Muchas familias hacen una revisión rápida para no pagar de más ni perder beneficios. Toma pocos minutos. Tengo ${offer}. ¿Cuál le conviene?`
       : `Good to hear—many families still do a quick review to make sure they’re not overpaying or missing benefits. I have ${offer}. Which works better for you?`,
  brushoff: (es, offer) =>
    es ? `Entiendo. Mantengámoslo simple; toma pocos minutos. Tengo ${offer}. ¿Cuál prefiere?`
       : `Totally understand—let’s keep it simple. It only takes a few minutes. I have ${offer}. Which works better for you?`,
  spouse: (es, offer) =>
    es ? `Perfecto—mejor cuando estén ambos. Tengo ${offer}. ¿Cuál funciona mejor para ustedes?`
       : `Makes sense—let’s set a quick time when you can both be on. I have ${offer}. Which works best for you two?`,
  wrong: (es) =>
    es ? `¡Disculpe la molestia!`
       : `My apologies!`,
  agree: (es, offer) =>
    es ? `Perfecto—agendemos unos minutos. Tengo ${offer}. ¿Cuál prefiere?`
       : `Great—let’s set aside a few minutes. I have ${offer}. Which works best for you?`,
  timeConfirm: (es, label) =>
    es ? `Perfecto, le llamo a las ${label}. Lo mantenemos en unos minutos.`
       : `Perfect, I’ll call you at ${label}. We’ll keep it to just a few minutes.`,
  link: (es, link) =>
    es ? ` Aquí está el enlace para confirmar y recibir recordatorios (puede reprogramar si hace falta): ${link}`
       : ` Here’s a quick link to confirm so you’ll get reminders (and can reschedule if needed): ${link}`,
  reschedule: (es, offer) =>
    es ? `Claro, reprogramemos. Tengo ${offer}. ¿Cuál le funciona?`
       : `Absolutely—let’s reschedule. I have ${offer}. Which works for you?`,
};

/* ---------------- Decide ---------------- */
function decide({ text, agentName, calendlyLink, tz, officeHours } = {}) {
  tz = tz || DEFAULT_TZ;
  const hours = officeHours || DEFAULT_HOURS;

  const es = detectSpanish(text);
  const intent = classify(text);

  const { dayWord, slots } = synthesizeSlots({ tz, hours, basePicks: [8, 13, 18] }); // 8a / 1p / 6p
  const offer = offerTxt(dayWord, slots);
  const name = agentName || (es ? "su corredor autorizado" : "your licensed broker");

  // explicit time → confirm + optional link (use the user-provided label)
  if (intent === "time_specific") {
    const m =
      String(text).match(/\b(1?\d(?::\d{2})?\s?(a\.?m\.?|p\.?m\.?|am|pm))\b/i) ||
      String(text).match(/\b(1?\d:\d{2})\b/);
    const label = m ? m[1].toUpperCase().replace(/\s+/g, " ") : (slots[1] || slots[0] || "the time we discussed");
    let out = T.timeConfirm(es, label);
    if (calendlyLink) out += T.link(es, calendlyLink);
    return { text: out, intent: "confirm_time" };
  }

  if (intent === "reschedule") {
    let out = T.reschedule(es, offer);
    if (calendlyLink) out += T.link(es, calendlyLink);
    return { text: out, intent: "reschedule" };
  }

  if (intent === "greet")     return { text: T.greet(es, name, offer),    intent };
  if (intent === "who")       return { text: T.who(es, name, offer),      intent };  // <-- now hits for "who's this?"
  if (intent === "price")     return { text: T.price(es, offer),          intent };
  if (intent === "covered")   return { text: T.covered(es, offer),        intent };
  if (intent === "brushoff")  return { text: T.brushoff(es, offer),       intent };
  if (intent === "spouse")    return { text: T.spouse(es, offer),         intent };
  if (intent === "wrong")     return { text: T.wrong(es),                  intent };
  if (intent === "agree")     return { text: T.agree(es, offer),           intent };
  if (intent === "time_window" || intent === "general") {
    return { text: T.agree(es, offer), intent: "offer_slots" };
  }
  if (intent === "stop") {
    return { text: "", intent: "stop" }; // upstream STOP logic handles it
  }
  return { text: T.agree(es, offer), intent: "offer_slots" };
}

module.exports = { decide };
