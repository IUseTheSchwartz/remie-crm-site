// File: netlify/functions/ai-brain.js
// Hybrid brain: deterministic rules first; optional Groq fallback for classification only.
// Exports: decide({ text, agentName, calendlyLink, tz, officeHours, context, useLLM, llmMinConf }) -> { text, intent, meta? }

const { llmClassify } = require("./ai-brain-llm-helper");

const DEFAULT_TZ = "America/Chicago";
const DEFAULT_HOURS = { start: 9, end: 21 }; // inclusive local window
const LLM_ENABLED = String(process.env.AI_BRAIN_USE_LLM || "true").toLowerCase() === "true";
const LLM_MIN_CONF = Number(process.env.AI_BRAIN_LLM_CONFIDENCE || 0.55);

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
  const x = normalize(t);
  const m = x.match(/\b([1-9]|1[0-2])\b/);
  if (!m) return false;
  if (/\b(am|pm)\b/.test(x) || /\d:\d{2}/.test(x)) return false;
  if (/\bafter\s+[1-9]|1[0-2]\b/.test(x)) return false;
  return true;
}

/* ---------------- Copy templates (more natural, small variations) ---------------- */
const T = {
  greetFirst: (es, n, offer, ctx) => {
    const first = safe(ctx?.firstName);
    const state = safe(ctx?.state);
    const bene  = safe(ctx?.beneficiary);
    if (es) {
      const intro = first ? `Hola ${first}, soy ${n}.` : `Hola—soy ${n}.`;
      const bit = (state || bene)
        ? `Vi el formulario que envió${state ? ` en ${state}` : ""}${bene ? ` (donde puso a ${bene} como beneficiario)` : ""}.`
        : `Vi el formulario que envió.`;
      const close = pick([`¿Le funciona ${offer}?`,`Tengo ${offer}. ¿Cuál prefiere?`,`Podemos verlo en 5 minutos—${offer} le queda bien?`]);
      return `${intro} ${bit} ${close}`;
    }
    const intro = first ? `Hey ${first}, it’s ${n}.` : `Hey—it’s ${n}.`;
    const bit = (state || bene)
      ? `Saw the form you sent${state ? ` in ${state}` : ""}${bene ? ` (the one listing ${bene})` : ""}.`
      : `Saw the form you sent in.`;
    const close = pick([`Does ${offer} work?`,`I can do ${offer}. What works best?`,`We can keep it to ~5 mins—would ${offer} work?`]);
    return `${intro} ${bit} ${close}`;
  },

  greet: (es, n, offer, ctx) => {
    const first = safe(ctx?.firstName);
    if (es) {
      const open = pick([
        first ? `Hola ${first},` : `Hola,`,
        `¡Buenas!`,
      ]);
      const tail = pick([`¿Le funciona ${offer}?`, `Puedo ${offer}. ¿Cuál prefiere?`]);
      return `${open} soy ${n}. ${tail}`;
    }
    const open = pick([
      first ? `Hey ${first},` : `Hey,`,
      `Hi there,`,
    ]);
    const tail = pick([`Would ${offer} work?`, `I can do ${offer}. Which is better for you?`]);
    return `${open} it’s ${n}. ${tail}`;
  },

  courtesy: (es, n, offer) =>
    es ? pick([`¡Bien, gracias!`,`Todo bien, gracias.`]) + ` Tengo ${offer}. ¿Cuál le conviene?`
       : pick([`Doing well, thanks!`,`All good, thanks for asking.`]) + ` I can do ${offer}. Which works for you?`,

  who: (es, n, offer, ctx) => {
    const first = safe(ctx?.firstName);
    const state = safe(ctx?.state);
    const bene  = safe(ctx?.beneficiary);
    if (es) {
      const intro = first ? `Hola ${first}, soy ${n}.` : `Hola, soy ${n}.`;
      const bit = (state || bene)
        ? `Usted envió una solicitud${state ? ` en ${state}` : ""}${bene ? ` donde puso a ${bene} como beneficiario` : ""}.`
        : `Usted envió una solicitud de seguro de vida.`;
      const close = pick([`¿Le funciona ${offer}?`,`Lo vemos en 5 minutos—${offer} está bien?`]);
      return `${intro} ${bit}. ${close}`;
    }
    const intro = first ? `Hey ${first}, this is ${n}.` : `Hey, this is ${n}.`;
    const bit = (state || bene)
      ? `You sent a request${state ? ` in ${state}` : ""}${bene ? ` and listed ${bene} as the beneficiary` : ""}.`
      : `You sent in a request for life insurance.`;
    const close = pick([`Does ${offer} work?`,`We can do a quick 5-min review—would ${offer} work?`]);
    return `${intro} ${bit}. ${close}`;
  },

  price: (es, offer) =>
    es ? `Buena pregunta—depende de edad, salud y cobertura. Lo vemos rápido por teléfono. Tengo ${offer}. ¿Cuál prefiere?`
       : `Good question—it depends on age, health, and coverage. Easiest is a quick call. I can do ${offer}. Which works?`,

  covered: (es, offer) =>
    es ? `Genial. Aun así, muchos hacen una revisión corta para no pagar de más ni perder beneficios. Tengo ${offer}. ¿Cuál le conviene?`
       : `Nice. Folks still do a quick review to make sure they’re not overpaying or missing benefits. I can do ${offer}. Which is better?`,

  brushoff: (es, offer) =>
    es ? `Entiendo. Lo dejamos simple y corto. Tengo ${offer}. ¿Cuál prefiere?`
       : `Totally get it—let’s keep it quick. I can do ${offer}. Which works better?`,

  spouse: (es, offer) =>
    es ? `Perfecto—mejor cuando estén ambos. Tengo ${offer}. ¿Qué hora les conviene?`
       : `Makes sense—best when you’re both on. I can do ${offer}. What works for you two?`,

  wrong: (es) =>
    es ? `Sin problema. Si necesita opciones más adelante, avíseme.`
       : `No worries. If you ever want to look at options later, just text me.`,

  agree: (es, offer) =>
    es ? `Perfecto—agendemos unos minutos. Tengo ${offer}. ¿Cuál prefiere?`
       : `Great—let’s set a few minutes. I can do ${offer}. Which works for you?`,

  timeConfirm: (es, label) =>
    es ? `Perfecto, le llamo a las ${label}. Lo mantengo breve.`
       : `Perfect, I’ll call you at ${label}. I’ll keep it quick.`,

  link: (es, link) =>
    es ? ` Aquí tiene un enlace para confirmar y recibir recordatorios (puede reprogramar si hace falta): ${link}`
       : ` Here’s a quick link to confirm so you’ll get reminders (and can reschedule if needed): ${link}`,

  reschedule: (es, offer) =>
    es ? `Claro, reprogramemos. Tengo ${offer}. ¿Cuál le funciona?`
       : `Absolutely—let’s reschedule. I can do ${offer}. Which works for you?`,

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

  if (intentDet === "stop") return { text: "", intent: "stop", meta: { route: "deterministic" } };

  // Special: "how are you?"
  if (intentDet === "courtesy_greet") {
    return { text: T.courtesy(es, name, offer), intent: "courtesy_greet", meta: { route: "deterministic" } };
  }

  // Time-specific (deterministic) — also catch "noon"
  if (/\bnoon\b/i.test(text)) {
    let out = T.timeConfirm(es, "12 PM");
    if (calendlyLink) out += T.link(es, calendlyLink);
    return { text: out, intent: "confirm_time", meta: { route: "deterministic" } };
  }
  if (intentDet === "time_specific") {
    const m = String(text).match(/\b(1?\d(?::\d{2})?\s?(a\.?m\.?|p\.?m\.?|am|pm))\b/i) || String(text).match(/\b(1?\d:\d{2})\b/);
    const label = m ? m[1].toUpperCase().replace(/\s+/g, " ") : (slots[1] || slots[0] || "the time we discussed");
    let out = T.timeConfirm(es, label);
    if (calendlyLink) out += T.link(es, calendlyLink);
    return { text: out, intent: "confirm_time", meta: { route: "deterministic" } };
  }

  // Bare hour like "7" → clarify
  if (hasAmbiguousBareHour(text)) {
    const h = String(text).match(/\b([1-9]|1[0-2])\b/)[1];
    return { text: T.clarifyTime(es, h), intent: "clarify_time", meta: { route: "deterministic" } };
  }

  // Time window
  if (intentDet === "time_window") {
    const winSlots = pickByWindow(slots, slotHours, text);
    const winOffer = offerTxt(dayWord, winSlots);
    return { text: T.agree(es, winOffer), intent: "offer_slots_windowed", meta: { route: "deterministic" } };
  }

  // Direct mappings
  if (intentDet === "reschedule") return { text: T.reschedule(es, offer), intent: "reschedule", meta: { route: "deterministic" } };

  if (intentDet === "greet") {
    const firstTurn = context?.firstTurn === true;
    if (firstTurn) return { text: T.greetFirst(es, name, offer, context), intent: "greet_first_turn", meta: { route: "deterministic" } };
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

      if (intent === "courtesy_greet") return { text: T.courtesy(es, name, offer), intent, meta: { route: "llm", conf: llm.confidence } };
      if (intent === "greet")          return { text: T.greet(es, name, offer, context), intent, meta: { route: "llm", conf: llm.confidence } };
      if (intent === "who")            return { text: T.who(es, name, offer, context),   intent, meta: { route: "llm", conf: llm.confidence } };
      if (intent === "price")          return { text: T.price(es, offer),                intent, meta: { route: "llm", conf: llm.confidence } };
      if (intent === "covered")        return { text: T.covered(es, offer),              intent, meta: { route: "llm", conf: llm.confidence } };
      if (intent === "brushoff")       return { text: T.brushoff(es, offer),             intent, meta: { route: "llm", conf: llm.confidence } };
      if (intent === "spouse")         return { text: T.spouse(es, offer),               intent, meta: { route: "llm", conf: llm.confidence } };
      if (intent === "wrong")          return { text: T.wrong(es),                       intent, meta: { route: "llm", conf: llm.confidence } };
      if (intent === "callme")         return { text: T.greet(es, name, offer, context), intent, meta: { route: "llm", conf: llm.confidence } };
      if (intent === "agree")          return { text: T.agree(es, offer),                intent, meta: { route: "llm", conf: llm.confidence } };
    }
  }

  // Fallback general
  const firstTurn = context?.firstTurn === true;
  if (firstTurn) {
    return { text: T.greetFirst(es, name, offer, context), intent: "greet_first_turn", meta: { route: "fallback" } };
  }
  return { text: T.greet(es, name, offer, context), intent: "offer_slots", meta: { route: "fallback" } };
}

module.exports = { decide };
