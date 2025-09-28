// File: netlify/functions/ai-brain.js
// Hybrid brain: deterministic rules first; optional Groq fallback for classification only.
// Exports: decide({ text, agentName, calendlyLink, tz, officeHours, context, useLLM, llmMinConf }) -> { text, intent, meta? }

// ---- SAFE LLM IMPORT (won't crash if helper/env missing)
let llmClassify = async () => ({ intent: "", confidence: 0 });
try { llmClassify = require("./ai-brain-llm-helper").llmClassify; } catch {}

const DEFAULT_TZ = "America/Chicago";
const DEFAULT_HOURS = { start: 9, end: 21 }; // inclusive local window
const LLM_ENABLED = String(process.env.AI_BRAIN_USE_LLM || "false").toLowerCase() === "true";
const LLM_MIN_CONF = Number(process.env.AI_BRAIN_LLM_CONFIDENCE || 0.55);

// Deliverability helper: add STOP footer (recommended for TFN/10DLC)
const ADD_STOP_FOOTER = String(process.env.AI_BRAIN_ADD_STOP_FOOTER || "true").toLowerCase() === "true";
const STOP_FOOTER_EN = " Reply STOP to opt out.";
const STOP_FOOTER_ES = " Responda STOP para dejar de recibir mensajes.";

/* ---------------- Small helpers ---------------- */
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const safe = (s) => (s ? String(s).trim() : "");

/* ---------------- Language detection ---------------- */
function detectSpanish(t = "") {
  const s = String(t).toLowerCase();
  if (/[ñáéíóúü¿¡]/.test(s)) return true;
  const esHints = ["cuánto","cuanto","precio","costo","seguro","vida","mañana","manana","tarde","noche","quien","quién","numero","número","equivocado","esposo","esposa","si","sí","vale","claro","buenas","hola"];
  let score = 0; for (const w of esHints) if (s.includes(w)) score++;
  return score >= 2;
}

/* ---------------- Intent classification (deterministic) ---------------- */
function normalize(t = "") { return String(t).trim().toLowerCase().replace(/\s+/g, " "); }

function classify(t = "") {
  const x = normalize(t);
  if (!x) return "general";

  if (/\b(how are you|how’s it going|how's it going|hru|how are u|how r you)\b/.test(x)) return "courtesy_greet";

  if (/^(k|kk|kay|ok(ay)?|sure|sounds good|works|perfect|great|cool|yep|yeah|si|sí|vale|dale|va)\b/.test(x)) return "agree";
  if (/^(nah|nope|not now|no)\b/.test(x)) return "brushoff";

  if (/\b(stop|unsubscribe|quit|cancel)\b/.test(x)) return "stop";

  if (/\b(price|how much|cost|monthly|payment|premium|quote|rate|rates?)\b/.test(x) ||
      /\b(cu[áa]nto|precio|costo|pago|mensual|cuota|prima)\b/.test(x)) return "price";

  if (/\b(who('?|’)?s|whos)\s+this\??\b/.test(x) ||
      /\bwho\s+is\s+this\??\b/.test(x) ||
      /\bwho are you\??\b/.test(x) ||
      /\bhow did you get (my|this) (number|#)\b/.test(x) ||
      /\bwhy (are|r) you texting\b/.test(x) ||
      /\bqui[eé]n (eres|habla|manda|me escribe)\b/.test(x)) return "who";

  if (/\b(already have|i have insurance|covered|i'?m covered|policy already)\b/.test(x) ||
      /\b(ya tengo|tengo seguro|ya estoy cubiert[oa])\b/.test(x)) return "covered";

  if (/\b(not interested|stop texting|leave me alone|busy|working|at work|later|another time|no thanks)\b/.test(x) ||
      /\b(no me interesa|ocupad[oa]|luego|m[aá]s tarde|otro d[ií]a)\b/.test(x)) return "brushoff";

  if (/\bwrong number|not (me|my number)\b/.test(x) || /\bn[uú]mero equivocado\b/.test(x)) return "wrong";

  if (/\b(spouse|wife|husband|partner)\b/.test(x) || /\bespos[ao]\b/.test(x)) return "spouse";

  if (/\b(call|ring|phone me|give me a call|ll[aá]mame|llamar)\b/.test(x)) return "callme";

  if (/\b(resched|re[- ]?schedule|different time|change (the )?time|move (it|appt)|new time)\b/i.test(x) ||
      /\b(reprogramar|cambiar hora|otra hora|mover la cita)\b/.test(x)) return "reschedule";

  if (/\b(tom(orrow)?|today|evening|afternoon|morning|tonight|this (afternoon|evening|morning))\b/.test(x) ||
      /\b(ma[ñn]ana|hoy|tarde|noche)\b/.test(x)) return "time_window";

  if (/\b(1?\d(?::\d{2})?\s?(a\.?m\.?|p\.?m\.?|am|pm))\b/.test(x) || /\b(1?\d:\d{2})\b/.test(x)) return "time_specific";

  if (/^(hi|hey|hello|hola|buenas)\b/.test(x)) return "greet";

  return "general";
}

/* ---------------- Time helpers (only for confirmations/clarifications) ---------------- */
function getLocalHour24(tz = DEFAULT_TZ) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "numeric", hour12: true })
    .formatToParts(new Date()).reduce((a, p) => (a[p.type] = p.value, a), {});
  let h = parseInt(parts.hour, 10);
  const period = (parts.dayPeriod || parts.dayperiod || "").toLowerCase();
  if (period === "pm" && h < 12) h += 12;
  if (period === "am" && h === 12) h = 0;
  return h;
}
function clampSlotHours(baseHours, window) {
  const uniq = [...new Set(baseHours.map(h => Math.round(h)))];
  return uniq.map(h => Math.min(Math.max(h, window.start), window.end)).filter(h => h >= window.start && h <= window.end);
}
function fmtHour12(h, min = 0) {
  const hour12 = ((h + 11) % 12) + 1;
  const ampm = h < 12 ? "AM" : "PM";
  const mm = String(min).padStart(2, "0");
  return mm === "00" ? `${hour12} ${ampm}` : `${hour12}:${mm} ${ampm}`;
}
function synthesizeSlots({ tz = DEFAULT_TZ, hours = DEFAULT_HOURS, basePicks = [8, 13, 18] } = {}) {
  const nowH = getLocalHour24(tz);
  const sameDay = nowH <= (hours.end - 2);
  let picks = clampSlotHours(basePicks, hours);
  if (!picks.length) picks = clampSlotHours([hours.start, hours.start + 2, Math.min(hours.end, hours.start + 8)], hours);
  const labels = picks.slice(0, 3).map(h => fmtHour12(h, 0));
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: tz }).format(tomorrow);
  const dayWord = sameDay ? "" : ` (${weekday})`;
  return { sameDay, dayWord, slots: labels, slotHours: picks };
}
function hasAmbiguousBareHour(t) {
  const x = normalize(t);
  const m = x.match(/\b([1-9]|1[0-2])\b/);
  if (!m) return false;
  if (/\b(am|pm)\b/.test(x) || /\d:\d{2}/.test(x)) return false;
  if (/\bafter\s+[1-9]|1[0-2]\b/.test(x)) return false;
  return true;
}

/* ---------------- Copy templates (no time-slot lists) ---------------- */
const T = {
  // First turn or plain greet; natural bridge and Calendly CTA
  greetFirst: (es, n, ctx) => {
    const first = safe(ctx?.firstName);
    if (es) {
      const intro = first ? `Hola ${first}, soy ${n}.` : `Hola—soy ${n}.`;
      return `${intro} Vi su solicitud de seguro de vida. Podemos verlo en unos minutos.`;
    }
    const intro = first ? `Hey ${first}, it’s ${n}.` : `Hey—it’s ${n}.`;
    return `${intro} I saw your life-insurance request. We can go over it in a few minutes.`;
  },
  greet: (es, n, ctx) => {
    const first = safe(ctx?.firstName);
    if (es) {
      const intro = first ? `Hola ${first},` : `Hola,`;
      return `${intro} soy ${n}. Sobre su solicitud de seguro de vida—podemos verlo rápido.`;
    }
    const intro = first ? `Hi ${first},` : `Hi there,`;
    return `${intro} it’s ${n}. About your life-insurance request—easy to review quickly.`;
  },

  courtesy: (es) =>
    es ? pick([`¡Bien, gracias!`,`Todo bien, gracias.`])
       : pick([`Doing well, thanks!`,`All good—thanks for asking.`]),

  who: (es, n, ctx) => {
    const first = safe(ctx?.firstName);
    if (es) {
      const intro = first ? `Hola ${first}, soy ${n}.` : `Hola, soy ${n}.`;
      return `${intro} Usted pidió información de seguro de vida hace poco. Podemos verlo en unos minutos.`;
    }
    const intro = first ? `Hey ${first}, this is ${n}.` : `Hey, this is ${n}.`;
    return `${intro} You requested life-insurance info recently. We can review everything in a few minutes.`;
  },

  price: (es) =>
    es ? `Buena pregunta—depende de edad, salud y cobertura. Lo más fácil es una llamada corta.`
       : `Great question—it depends on age, health, and coverage. Easiest is a quick call to get exact options.`,

  covered: (es) =>
    es ? `Perfecto. Igual muchos hacen una revisión corta para no pagar de más ni perder beneficios.`
       : `Nice. Folks still do a quick review to make sure they’re not overpaying or missing benefits.`,

  brushoff: (es) =>
    es ? `Entiendo. Lo mantengo breve y simple.`
       : `Totally get it—I’ll keep it quick and simple.`,

  spouse: (es) =>
    es ? `De acuerdo—mejor cuando estén ambos.`
       : `Makes sense—best when you’re both on.`,

  wrong: (es) =>
    es ? `Sin problema. Si necesita opciones más adelante, avíseme.`
       : `No worries. If you ever want to look at options later, just text me.`,

  agree: (es) =>
    es ? `Perfecto—agendemos unos minutos.`
       : `Great—let’s set aside a few minutes.`,

  timeConfirm: (es, label) =>
    es ? `Perfecto, le llamo a las ${label}. Lo mantengo breve.`
       : `Perfect, I’ll call you at ${label}. I’ll keep it quick.`,

  link: (es, link) =>
    es ? ` Aquí tiene un enlace para confirmar y recibir recordatorios (y reprogramar si hace falta): ${link}`
       : ` Here’s a link to confirm so you’ll get reminders (and can reschedule if needed): ${link}`,
};

// always append Calendly link (when present) + STOP footer (configurable)
function finalize(text, es, link) {
  let out = String(text || "").trim();
  if (link) out += T.link(es, link);
  if (ADD_STOP_FOOTER) out += (es ? STOP_FOOTER_ES : STOP_FOOTER_EN);
  return out;
}

/* ---------------- Decide ---------------- */
async function decide({ text, agentName, calendlyLink, tz, officeHours, context, useLLM, llmMinConf } = {}) {
  tz = tz || DEFAULT_TZ;
  const hours = officeHours || DEFAULT_HOURS;
  const es = detectSpanish(text);
  const name = agentName || (es ? "su corredor autorizado" : "your licensed broker");

  // keep slots util only for confirms/clarifications
  synthesizeSlots({ tz, hours, basePicks: [8, 13, 18] });

  const intentDet = classify(text);

  if (intentDet === "stop") return { text: "", intent: "stop", meta: { route: "deterministic" } };

  // Courtesy “how are you?”
  if (intentDet === "courtesy_greet") {
    return { text: finalize(T.courtesy(es), es, calendlyLink), intent: "courtesy_greet", meta: { route: "deterministic" } };
  }

  // Time-specific (also catch "noon")
  if (/\bnoon\b/i.test(text)) {
    return { text: finalize(T.timeConfirm(es, "12 PM"), es, calendlyLink), intent: "confirm_time", meta: { route: "deterministic" } };
  }
  if (intentDet === "time_specific") {
    const m = String(text).match(/\b(1?\d(?::\d{2})?\s?(a\.?m\.?|p\.?m\.?|am|pm))\b/i) || String(text).match(/\b(1?\d:\d{2})\b/);
    const label = m ? m[1].toUpperCase().replace(/\s+/g, " ") : "the time we discussed";
    return { text: finalize(T.timeConfirm(es, label), es, calendlyLink), intent: "confirm_time", meta: { route: "deterministic" } };
  }

  // Bare hour like "7" -> ask AM/PM
  if (hasAmbiguousBareHour(text)) {
    const h = String(text).match(/\b([1-9]|1[0-2])\b/)[1];
    const msg = es ? `¿Le queda mejor ${h} AM o ${h} PM? Puedo acomodarme.` : `Does ${h} work better AM or PM? I can make either work.`;
    return { text: finalize(msg, es, calendlyLink), intent: "clarify_time", meta: { route: "deterministic" } };
  }

  // Time window -> keep natural + link (no slot lists)
  if (intentDet === "time_window") {
    const msg = es
      ? `De acuerdo. Elija la hora que le quede mejor en el enlace.`
      : `Got it—pick whatever time works best for you at the link.`;
    return { text: finalize(msg, es, calendlyLink), intent: "time_window", meta: { route: "deterministic" } };
  }

  // Direct mappings (no time-slot offers)
  if (intentDet === "reschedule") return { text: finalize(``, es, calendlyLink) || finalize(es ? `Claro, reprogramemos.` : `Absolutely—let’s reschedule.`, es, calendlyLink), intent: "reschedule", meta: { route: "deterministic" } };

  if (intentDet === "greet") {
    const firstTurn = context?.firstTurn === true;
    const base = firstTurn ? T.greetFirst(es, name, context) : T.greet(es, name, context);
    return { text: finalize(base, es, calendlyLink), intent: firstTurn ? "greet_first_turn" : "greet", meta: { route: "deterministic" } };
  }

  if (intentDet === "who")      return { text: finalize(T.who(es, name, context), es, calendlyLink), intent: "who", meta: { route: "deterministic" } };
  if (intentDet === "price")    return { text: finalize(T.price(es), es, calendlyLink), intent: "price", meta: { route: "deterministic" } };
  if (intentDet === "covered")  return { text: finalize(T.covered(es), es, calendlyLink), intent: "covered", meta: { route: "deterministic" } };
  if (intentDet === "brushoff") return { text: finalize(T.brushoff(es), es, calendlyLink), intent: "brushoff", meta: { route: "deterministic" } };
  if (intentDet === "spouse")   return { text: finalize(T.spouse(es), es, calendlyLink), intent: "spouse", meta: { route: "deterministic" } };
  if (intentDet === "wrong")    return { text: finalize(T.wrong(es), es, calendlyLink), intent: "wrong", meta: { route: "deterministic" } };
  if (intentDet === "callme")   return { text: finalize(T.greet(es, name, context), es, calendlyLink), intent: "callme", meta: { route: "deterministic" } };
  if (intentDet === "agree")    return { text: finalize(T.agree(es), es, calendlyLink), intent: "agree", meta: { route: "deterministic" } };

  // ---------- LLM fallback (classification only) ----------
  const wantLLM = typeof useLLM === "boolean" ? useLLM : LLM_ENABLED;
  const minConf = typeof llmMinConf === "number" ? llmMinConf : LLM_MIN_CONF;

  if (wantLLM) {
    const llm = await llmClassify(text);
    if (llm.confidence >= minConf) {
      const intent = llm.intent;

      if (intent === "time_specific" && llm.time?.type === "specific" && llm.time.value) {
        return { text: finalize(T.timeConfirm(es, llm.time.value), es, calendlyLink), intent: "confirm_time", meta: { route: "llm", conf: llm.confidence } };
      }
      if (intent === "time_window") {
        const msg = es
          ? `De acuerdo. Elija la hora que le quede mejor en el enlace.`
          : `Got it—pick whatever time works best for you at the link.`;
        return { text: finalize(msg, es, calendlyLink), intent: "time_window", meta: { route: "llm", conf: llm.confidence } };
      }

      if (intent === "courtesy_greet") return { text: finalize(T.courtesy(es), es, calendlyLink), intent, meta: { route: "llm", conf: llm.confidence } };
      if (intent === "greet")          return { text: finalize(T.greet(es, name, context), es, calendlyLink), intent, meta: { route: "llm", conf: llm.confidence } };
      if (intent === "who")            return { text: finalize(T.who(es, name, context), es, calendlyLink), intent, meta: { route: "llm", conf: llm.confidence } };
      if (intent === "price")          return { text: finalize(T.price(es), es, calendlyLink), intent, meta: { route: "llm", conf: llm.confidence } };
      if (intent === "covered")        return { text: finalize(T.covered(es), es, calendlyLink), intent, meta: { route: "llm", conf: llm.confidence } };
      if (intent === "brushoff")       return { text: finalize(T.brushoff(es), es, calendlyLink), intent, meta: { route: "llm", conf: llm.confidence } };
      if (intent === "spouse")         return { text: finalize(T.spouse(es), es, calendlyLink), intent, meta: { route: "llm", conf: llm.confidence } };
      if (intent === "wrong")          return { text: finalize(T.wrong(es), es, calendlyLink), intent, meta: { route: "llm", conf: llm.confidence } };
      if (intent === "callme")         return { text: finalize(T.greet(es, name, context), es, calendlyLink), intent, meta: { route: "llm", conf: llm.confidence } };
      if (intent === "agree")          return { text: finalize(T.agree(es), es, calendlyLink), intent, meta: { route: "llm", conf: llm.confidence } };
    }
  }

  // Fallback
  const firstTurn = context?.firstTurn === true;
  const base = firstTurn ? T.greetFirst(es, name, context) : T.greet(es, name, context);
  return { text: finalize(base, es, calendlyLink), intent: firstTurn ? "greet_first_turn" : "offer_followup", meta: { route: "fallback" } };
}

module.exports = { decide };
