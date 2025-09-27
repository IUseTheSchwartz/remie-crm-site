// Pure response logic: language, intent, slots (9am–9pm), copy.
// Drop-in replacement for your current module.
// Exports: decide({ text, agentName, calendlyLink, tz, officeHours }) -> { text, intent }

const DEFAULT_TZ = "America/Chicago";
const DEFAULT_HOURS = { start: 9, end: 21 }; // inclusive window in local time

/* ---------------- Language detection ---------------- */
function detectSpanish(t = "") {
  const s = String(t).toLowerCase();
  if (/[ñáéíóúü¿¡]/.test(s)) return true;
  const esHints = [
    "cuánto", "cuanto", "precio", "costo", "seguro", "vida", "mañana", "manana",
    "tarde", "noche", "quien", "quién", "numero", "número", "equivocado", "esposo", "esposa",
    "si", "sí", "vale", "claro", "buenas", "hola",
  ];
  let score = 0;
  for (const w of esHints) if (s.includes(w)) score++;
  return score >= 2;
}

/* ---------------- Intent classification (robust) ---------------- */
function normalize(t = "") {
  return String(t).trim().toLowerCase().replace(/\s+/g, " ");
}
function classify(t = "") {
  const x = normalize(t);

  if (!x) return "general";
  // extreme short agrees / acks
  if (/^(k|kk|kay|ok(ay)?|y+|ya|ye+a?h?|si|sí|dale|va|vale|bet|sounds good|cool|alr|alright)\b/.test(x)) return "agree";
  if (/^(nah|nope|no)\b/.test(x)) return "brushoff";

  // unsubscribe handled upstream, but keep as signal
  if (/\b(stop|unsubscribe|quit|cancel)\b/.test(x)) return "stop";

  // price
  if (/\b(price|how much|cost|monthly|payment|premium|quote|rates?)\b/.test(x)) return "price";
  if (/\b(cu[áa]nto|precio|costo|pago|mensual|cuota|prima)\b/.test(x)) return "price";

  // who / provenance
  if (/\b(who( is|’s|'s)? (this|dis)|how did you get|why (are|r) you texting|identify|name)\b/.test(x)) return "who";
  if (/\bqui[eé]n (eres|habla|manda|me escribe)\b/.test(x)) return "who";

  // covered already
  if (/\b(already have|i have insurance|covered|i'm covered|policy already)\b/.test(x)) return "covered";
  if (/\b(ya tengo|tengo seguro|ya estoy cubiert[oa])\b/.test(x)) return "covered";

  // busy / brush-off
  if (/\b(not interested|stop texting|leave me alone|busy|working|at work|later|another time)\b/.test(x)) return "brushoff";
  if (/\b(no me interesa|ocupad[oa]|luego|m[aá]s tarde|otro d[ií]a)\b/.test(x)) return "brushoff";

  // wrong number
  if (/\bwrong number|not (me|my number)\b/.test(x)) return "wrong";
  if (/\bn[uú]mero equivocado\b/.test(x)) return "wrong";

  // spouse / both on call
  if (/\b(spouse|wife|husband|partner)\b/.test(x)) return "spouse";
  if (/\bespos[ao]\b/.test(x)) return "spouse";

  // explicit call me / phone
  if (/\b(call|ring|phone me|give me a call|ll[aá]mame|llamar)\b/.test(x)) return "callme";

  // reschedule / different time
  if (/\b(resched|re[- ]?schedule|different time|change (the )?time|move (it|appt)|new time)\b/.test(x)) return "reschedule";
  if (/\b(reprogramar|cambiar hora|otra hora|mover la cita)\b/.test(x)) return "reschedule";

  // time windows (“tomorrow morning”, etc.)
  if (/\b(tom(orrow)?|today|evening|afternoon|morning|tonight|this (afternoon|evening|morning))\b/.test(x)) return "time_window";
  if (/\b(ma[ñn]ana|hoy|tarde|noche|ma[ñn]ana en la ma[ñn]ana)\b/.test(x)) return "time_window";

  // explicit time like “10”, “10am”, “10:30 pm”
  if (/\b(1?\d(?::\d{2})?\s?(a\.?m\.?|p\.?m\.?|am|pm))\b/.test(x)) return "time_specific";
  if (/\b(1?\d:\d{2})\b/.test(x)) return "time_specific";

  // greetings
  if (/^(hi|hey|hello|hola|buenas)\b/.test(x)) return "greet";

  return "general";
}

/* ---------------- Slot synthesis ---------------- */
/**
 * Returns (bestEffort): same-day slots if now < (end-2h), else tomorrow.
 * Ensures slots within [start, end].
 * pickHours: default anchors, can shift inside window.
 */
function synthesizeSlots({ tz = DEFAULT_TZ, hours = DEFAULT_HOURS, pickHours = [9, 13, 18] } = {}) {
  const now = new Date();
  const localNow = toLocal(now, tz);
  const sameDayPossible = localNow.hour <= (hours.end - 2); // need 2h buffer

  const base = sameDayPossible ? startOfDay(now, tz) : addDays(startOfDay(now, tz), 1, tz);

  const slots = pickHours
    .map((h) => clampHour(h, hours))
    .filter((h, i, arr) => i === arr.findIndex((x) => x === h)) // unique
    .map((h) => dateAtHour(base, h, tz))
    .filter((d) => {
      const lh = toLocal(d, tz).hour;
      return lh >= hours.start && lh <= hours.end;
    })
    .map((d) => ({
      label: d.toLocaleTimeString("en-US", {
        hour: "numeric", minute: "2-digit", hour12: true, timeZone: tz,
      }),
      iso: d.toISOString(),
      hour: toLocal(d, tz).hour,
    }));

  const dayName = base.toLocaleDateString("en-US", { weekday: "long", timeZone: tz });
  const dayWord = sameDayPossible ? "" : ` (${dayName})`;
  return { dayName, sameDayPossible, dayWord, slots };
}
function toLocal(date, tz) {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "numeric", hour12: true });
  const parts = fmt.formatToParts(date).reduce((acc, p) => (acc[p.type] = p.value, acc), {});
  // crude: rebuild hour in 24h range
  let hour = parseInt(parts.hour, 10);
  const dayPeriod = parts.dayPeriod || parts.dayperiod || "";
  if (/pm/i.test(dayPeriod) && hour < 12) hour += 12;
  if (/am/i.test(dayPeriod) && hour === 12) hour = 0;
  return { hour, minute: parseInt(parts.minute || "0", 10) };
}
function startOfDay(date, tz) {
  const d = new Date(date);
  const { hour, minute } = toLocal(d, tz);
  // subtract local time to hit 00:00 local, approximate (good enough for slot calc)
  d.setHours(d.getHours() - hour, d.getMinutes() - minute, 0, 0);
  return d;
}
function addDays(date, days, _tz) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}
function clampHour(h, { start, end }) {
  return Math.min(Math.max(Math.round(h), start), end);
}
function dateAtHour(baseLocalMidnight, hour, tz) {
  const d = new Date(baseLocalMidnight);
  // set hour in that local day
  d.setHours(hour, 0, 0, 0);
  return d;
}

function offerTxt(dayWord, slots) {
  const labels = slots.map((s) => s.label);
  if (labels.length === 0) return "a quick time that works for you";
  if (labels.length === 1) return `${labels[0]}${dayWord}`;
  if (labels.length === 2) return `${labels[0]} or ${labels[1]}${dayWord}`;
  return `${labels[0]}, ${labels[1]}, or ${labels[2]}${dayWord}`;
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
    es ? `Excelente. Aun así, muchas familias hacen una revisión rápida para no pagar de más ni perder beneficios. Toma pocos minutos. Tengo ${offer}. ¿Cuál le conviene?`
       : `Good to hear—many families still do a quick review to make sure they’re not overpaying or missing benefits. I have ${offer}. Which works better for you?`,
  brushoff: (es, offer) =>
    es ? `Entiendo. Dejarlo claro toma pocos minutos. Tengo ${offer}. ¿Cuál prefiere?`
       : `Totally understand—let’s keep it simple. It only takes a few minutes. I have ${offer}. Which works better for you?`,
  spouse: (es, offer) =>
    es ? `Perfecto—mejor cuando est[eé]n ambos. Tengo ${offer}. ¿Cu[aá]l funciona mejor para ustedes?`
       : `Makes sense—let’s set a quick time when you can both be on. I have ${offer}. Which works best for you two?`,
  wrong: (es) =>
    es ? `¡Disculpe la molestia! Ya que estamos—¿tiene su seguro de vida al día?`
       : `My apologies! Since I’ve got you—have you already got your life insurance taken care of?`,
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

  const { dayWord, slots } = synthesizeSlots({
    tz,
    hours,
    // small nudge to “human” anchors; can tweak or pass via params later
    pickHours: [10, 14, 18], // 10:00a, 2:00p, 6:00p local
  });

  const offer = offerTxt(dayWord, slots);
  const name = agentName || (es ? "su corredor autorizado" : "your licensed broker");

  // explicit time → confirm + optional link
  if (intent === "time_specific") {
    const m = String(text).match(/\b(1?\d(?::\d{2})?\s?(a\.?m\.?|p\.?m\.?|am|pm))\b/i) || String(text).match(/\b(1?\d:\d{2})\b/);
    const label = m ? m[1].toUpperCase().replace(/\s+/g, " ") : (slots[1]?.label || slots[0]?.label || "the time we discussed");
    let out = T.timeConfirm(es, label);
    if (calendlyLink) out += T.link(es, calendlyLink);
    return { text: out, intent: "confirm_time" };
  }

  // reschedule (even if already booked)
  if (intent === "reschedule") {
    let out = T.reschedule(es, offer);
    if (calendlyLink) out += T.link(es, calendlyLink);
    return { text: out, intent: "reschedule" };
  }

  // other mapped intents
  if (intent === "greet")     return { text: T.greet(es, name, offer),    intent };
  if (intent === "who")       return { text: T.who(es, name, offer),      intent };
  if (intent === "price")     return { text: T.price(es, offer),          intent };
  if (intent === "covered")   return { text: T.covered(es, offer),        intent };
  if (intent === "brushoff")  return { text: T.brushoff(es, offer),       intent };
  if (intent === "spouse")    return { text: T.spouse(es, offer),         intent };
  if (intent === "wrong")     return { text: T.wrong(es),                  intent };
  if (intent === "agree")     return { text: T.agree(es, offer),           intent };
  if (intent === "time_window"|| intent === "general") {
    return { text: T.agree(es, offer), intent: "offer_slots" };
  }

  // stop: upstream usually handles, but be safe: return no text
  if (intent === "stop") {
    return { text: "", intent: "stop" };
  }

  return { text: T.agree(es, offer), intent: "offer_slots" };
}

module.exports = { decide };
