// File: netlify/functions/ai-brain.js
// Hybrid brain: deterministic rules first; optional Groq fallback for classification only.
// Exports: decide({ text, agentName, calendlyLink, tz, officeHours, context, useLLM, llmMinConf }) -> { text, intent, meta? }

const { llmClassify } = require("./ai-brain-llm-helper");

const DEFAULT_TZ = "America/Chicago";
const DEFAULT_HOURS = { start: 9, end: 21 }; // inclusive local window
const LLM_ENABLED = String(process.env.AI_BRAIN_USE_LLM || "true").toLowerCase() === "true";
const LLM_MIN_CONF = Number(process.env.AI_BRAIN_LLM_CONFIDENCE || 0.55);

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

  if (/^(k|kk|kay|ok(ay)?|sure|sounds good|works|perfect|great|cool|yep|yeah|si|sí|vale|dale|va)\b/.test(x)) return "agree";
  if (/^(nah|nope|not now|no)\b/.test(x)) return "brushoff";
  if (/\b(stop|unsubscribe|quit|cancel)\b/.test(x)) return "stop";
  if (/\b(price|how much|cost|monthly|payment|premium|quote|rate|rates)\b/.test(x) || /\b(cu[áa]nto|precio|costo|pago|mensual|cuota|prima)\b/.test(x)) return "price";
  if (/\b(who('?|’)?s|whos)\s+this\??\b/.test(x) || /\bwho\s+is\s+this\??\b/.test(x) || /\bwho are you\??\b/.test(x) || /\bhow did you get (my|this) (number|#)\b/.test(x) || /\bwhy (are|r) you texting\b/.test(x) || /\bqui[eé]n (eres|habla|manda|me escribe)\b/.test(x)) return "who";
  if (/\b(already have|i have insurance|covered|i'?m covered|policy already)\b/.test(x) || /\b(ya tengo|tengo seguro|ya estoy cubiert[oa])\b/.test(x)) return "covered";
  if (/\b(not interested|stop texting|leave me alone|busy|working|at work|later|another time|no thanks)\b/.test(x) || /\b(no me interesa|ocupad[oa]|luego|m[aá]s tarde|otro d[ií]a)\b/.test(x)) return "brushoff";
  if (/\bwrong number|not (me|my number)\b/.test(x) || /\bn[uú]mero equivocado\b/.test(x)) return "wrong";
  if (/\b(spouse|wife|husband|partner)\b/.test(x) || /\bespos[ao]\b/.test(x)) return "spouse";
  if (/\b(call|ring|phone me|give me a call|ll[aá]mame|llamar)\b/.test(x)) return "callme";
  if (/\b(resched|re[- ]?schedule|different time|change (the )?time|move (it|appt)|new time)\b/i.test(x) || /\b(reprogramar|cambiar hora|otra hora|mover la cita)\b/.test(x)) return "reschedule";
  if (/\b(tom(orrow)?|today|evening|afternoon|morning|tonight|this (afternoon|evening|morning))\b/.test(x) || /\b(ma[ñn]ana|hoy|tarde|noche)\b/.test(x)) return "time_window";
  if (/\b(1?\d(?::\d{2})?\s?(a\.?m\.?|p\.?m\.?|am|pm))\b/.test(x) || /\b(1?\d:\d{2})\b/.test(x)) return "time_specific";
  if (/^(hi|hey|hello|hola|buenas)\b/.test(x)) return "greet";
  return "general";
}

/* ---------------- Time helpers ---------------- */
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
  return `${hour12}:${mm} ${ampm}`;
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
function offerTxt(dayWord, slots) {
  if (!slots.length) return "a quick time that works for you";
  if (slots.length === 1) return `${slots[0]}${dayWord}`;
  if (slots.length === 2) return `${slots[0]} or ${slots[1]}${dayWord}`;
  return `${slots[0]}, ${slots[1]}, or ${slots[2]}${dayWord}`;
}
function pickByWindow(slotLabels, slotHours, windowWord) {
  const pairs = slotLabels.map((label, i) => ({ label, hour: slotHours[i] }));
  if (/morning|ma[ñn]ana/i.test(windowWord)) {
    const m = pairs.filter(p => p.hour <= 12); return m.length ? m.map(p=>p.label) : slotLabels;
  }
  if (/afternoon|tarde/i.test(windowWord)) {
    const a = pairs.filter(p => p.hour >= 12 && p.hour < 17); return a.length ? a.map(p=>p.label) : slotLabels;
  }
  if (/evening|night|tonight|noche/i.test(windowWord)) {
    const e = pairs.filter(p => p.hour >= 17); return e.length ? e.map(p=>p.label) : slotLabels;
  }
  if (/after\s*(\d{1,2})/i.test(windowWord)) {
    const n = Number(RegExp.$1); const e = pairs.filter(p => p.hour >= (n%24)); return e.length ? e.map(p=>p.label) : slotLabels;
  }
  return slotLabels;
}
function hasAmbiguousBareHour(t) {
  // e.g., "7", "10 works", "let's do 5?" (no am/pm, no ':')
  const x = normalize(t);
  const m = x.match(/\b([1-9]|1[0-2])\b/);
  if (!m) return false;
  // if next token has am/pm, or contains ":" then it's not ambiguous
  if (/\b(am|pm)\b/.test(x) || /\d:\d{2}/.test(x)) return false;
  if (/\bafter\s+[1-9]|1[0-2]\b/.test(x)) return false; // handled as window
  return true;
}

/* ---------------- Copy templates ---------------- */
const T = {
  greet: (es, n, offer, ctx) =>
    es ? `Hola${ctx?.firstName ? ` ${ctx.firstName}` : ""}, soy ${n}. ¿Le funciona ${offer}?`
       : `Hey${ctx?.firstName ? ` ${ctx.firstName}` : ""}, it’s ${n}. Would ${offer} work?`,
  who: (es, n, offer, ctx) => {
    const bit = ctx?.beneficiary && ctx?.state
      ? (es ? `recibí su solicitud en ${ctx.state} donde puso a ${ctx.beneficiary} como beneficiario`
             : `I got your request in ${ctx.state} where you listed ${ctx.beneficiary} as beneficiary`)
      : (es ? `recibí su solicitud sobre seguro de vida` : `I got your life insurance request`);
    return es
      ? `Hola, soy ${n}. ${bit}. Podemos verlo en unos minutos—¿le funciona ${offer}?`
      : `Hey, this is ${n}. ${bit}. We can go over it in a few minutes—would ${offer} work?`;
  },
  price: (es, offer) =>
    es ? `Buena pregunta: el precio depende de edad, salud y cobertura. Lo vemos en una llamada corta. Tengo ${offer}. ¿Cuál prefiere?`
       : `Great question—price depends on age, health, and coverage. We can pin it down on a quick call. I have ${offer}. Which works best?`,
  covered: (es, offer) =>
    es ? `Perfecto. Muchas familias hacen una revisión rápida para no pagar de más ni perder beneficios. Toma pocos minutos. Tengo ${offer}. ¿Cuál le conviene?`
       : `Good to hear—many families still do a quick review to make sure they’re not overpaying or missing benefits. I have ${offer}. Which is better for you?`,
  brushoff: (es, offer) =>
    es ? `Entiendo. Lo mantenemos simple y corto. Tengo ${offer}. ¿Cuál prefiere?`
       : `Totally understand—we’ll keep it quick and simple. I have ${offer}. Which works better?`,
  spouse: (es, offer) =>
    es ? `Perfecto—mejor cuando estén ambos. Tengo ${offer}. ¿Cuál funciona mejor para ustedes?`
       : `Makes sense—let’s set a quick time when you can both be on. I have ${offer}. Which works best for you two?`,
  wrong: (es) =>
    es ? `¡Sin problema! Si necesita cotizar más adelante, avíseme.`
       : `No worries! If you ever want to look at options later, just let me know.`,
  agree: (es, offer) =>
    es ? `Genial—agendemos unos minutos. Tengo ${offer}. ¿Cuál prefiere?`
       : `Great—let’s set aside a few minutes. I have ${offer}. Which works for you?`,
  timeConfirm: (es, label) =>
    es ? `Perfecto, le llamo a las ${label}. Lo mantengo breve.`
       : `Perfect, I’ll call you at ${label}. I’ll keep it quick.`,
  link: (es, link) =>
    es ? ` Aquí tiene un enlace para confirmar y recibir recordatorios (puede reprogramar si hace falta): ${link}`
       : ` Here’s a quick link to confirm so you’ll get reminders (and can reschedule if needed): ${link}`,
  reschedule: (es, offer) =>
    es ? `Claro, reprogramemos. Tengo ${offer}. ¿Cuál le funciona?`
       : `Absolutely—let’s reschedule. I have ${offer}. Which works for you?`,
  clarifyTime: (es, h) =>
    es ? `¿Le queda mejor ${h} AM o ${h} PM? Puedo acomodarme.`
       : `Does ${h} work better AM or PM? I can make either work.`,
};

/* ---------------- Decide ---------------- */
async function decide({ text, agentName, calendlyLink, tz, officeHours, context, useLLM, llmMinConf } = {}) {
  tz = tz || DEFAULT_TZ;
  const hours = officeHours || DEFAULT_HOURS;
  const es = detectSpanish(text);
  const name = agentName || (es ? "su corredor autorizado" : "your licensed broker");
  const { dayWord, slots, slotHours } = synthesizeSlots({ tz, hours, basePicks: [8, 13, 18] });
  const offer = offerTxt(dayWord, slots);

  const intentDet = classify(text);

  // STOP → silence (upstream unsub should handle)
  if (intentDet === "stop") return { text: "", intent: "stop", meta: { route: "deterministic" } };

  // Time-specific (deterministic)
  if (intentDet === "time_specific") {
    const m = String(text).match(/\b(1?\d(?::\d{2})?\s?(a\.?m\.?|p\.?m\.?|am|pm))\b/i) || String(text).match(/\b(1?\d:\d{2})\b/);
    const label = m ? m[1].toUpperCase().replace(/\s+/g, " ") : (slots[1] || slots[0] || "the time we discussed");
    let out = T.timeConfirm(es, label);
    if (calendlyLink) out += T.link(es, calendlyLink);
    return { text: out, intent: "confirm_time", meta: { route: "deterministic" } };
  }

  // Bare hour like "7" → clarify deterministically
  if (hasAmbiguousBareHour(text)) {
    const h = String(text).match(/\b([1-9]|1[0-2])\b/)[1];
    return { text: T.clarifyTime(es, h), intent: "clarify_time", meta: { route: "deterministic" } };
  }

  // Time window (deterministic)
  if (intentDet === "time_window") {
    const winSlots = pickByWindow(slots, slotHours, text);
    const winOffer = offerTxt(dayWord, winSlots);
    return { text: T.agree(es, winOffer), intent: "offer_slots_windowed", meta: { route: "deterministic" } };
  }

  // Direct mappings (deterministic)
  if (intentDet === "reschedule") return { text: T.reschedule(es, offer), intent: "reschedule", meta: { route: "deterministic" } };
  if (intentDet === "greet") {
    const firstTurn = context?.firstTurn === true;
    if (firstTurn) return { text: T.who(es, name, offer, context), intent: "greet_first_turn", meta: { route: "deterministic" } };
    return { text: T.greet(es, name, offer, context), intent: "greet", meta: { route: "deterministic" } };
  }
  if (intentDet === "who")      return { text: T.who(es, name, offer, context), intent: "who", meta: { route: "deterministic" } };
  if (intentDet === "price")    return { text: T.price(es, offer), intent: "price", meta: { route: "deterministic" } };
  if (intentDet === "covered")  return { text: T.covered(es, offer), intent: "covered", meta: { route: "deterministic" } };
  if (intentDet === "brushoff") return { text: T.brushoff(es, offer), intent: "brushoff", meta: { route: "deterministic" } };
  if (intentDet === "spouse")   return { text: T.spouse(es, offer), intent: "spouse", meta: { route: "deterministic" } };
  if (intentDet === "wrong")    return { text: T.wrong(es), intent: "wrong", meta: { route: "deterministic" } };
  if (intentDet === "callme")   return { text: T.greet(es, name, offer, context), intent: "callme", meta: { route: "deterministic" } };
  if (intentDet === "agree")    return { text: T.agree(es, offer), intent: "agree", meta: { route: "deterministic" } };

  // ---------- LLM fallback (classification only) ----------
  const wantLLM = typeof useLLM === "boolean" ? useLLM : LLM_ENABLED;
  const minConf = typeof llmMinConf === "number" ? llmMinConf : LLM_MIN_CONF;

  if (wantLLM) {
    const llm = await llmClassify(text);
    if (llm.confidence >= minConf) {
      const intent = llm.intent;

      // Time via LLM
      if (intent === "time_specific" && llm.time?.type === "specific" && llm.time.value) {
        let out = T.timeConfirm(es, llm.time.value);
        if (calendlyLink) out += T.link(es, calendlyLink);
        return { text: out, intent: "confirm_time", meta: { route: "llm", conf: llm.confidence } };
      }
      if (intent === "time_window" && llm.time?.type === "window" && llm.time.value) {
        const winSlots = pickByWindow(slots, slotHours, llm.time.value);
        const winOffer = offerTxt(dayWord, winSlots);
        return { text: T.agree(es, winOffer), intent: "offer_slots_windowed", meta: { route: "llm", conf: llm.confidence } };
      }

      // Map other intents to templates (still preset copy)
      if (intent === "greet")     return { text: T.greet(es, name, offer, context), intent, meta: { route: "llm", conf: llm.confidence } };
      if (intent === "who")       return { text: T.who(es, name, offer, context),   intent, meta: { route: "llm", conf: llm.confidence } };
      if (intent === "price")     return { text: T.price(es, offer),                intent, meta: { route: "llm", conf: llm.confidence } };
      if (intent === "covered")   return { text: T.covered(es, offer),              intent, meta: { route: "llm", conf: llm.confidence } };
      if (intent === "brushoff")  return { text: T.brushoff(es, offer),             intent, meta: { route: "llm", conf: llm.confidence } };
      if (intent === "spouse")    return { text: T.spouse(es, offer),               intent, meta: { route: "llm", conf: llm.confidence } };
      if (intent === "wrong")     return { text: T.wrong(es),                       intent, meta: { route: "llm", conf: llm.confidence } };
      if (intent === "callme")    return { text: T.greet(es, name, offer, context), intent, meta: { route: "llm", conf: llm.confidence } };
      if (intent === "agree")     return { text: T.agree(es, offer),                intent, meta: { route: "llm", conf: llm.confidence } };
    }
  }

  // Fallback general
  return { text: T.agree(es, offer), intent: "offer_slots", meta: { route: "fallback" } };
}

module.exports = { decide };
