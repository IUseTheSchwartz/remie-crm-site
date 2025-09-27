// File: netlify/functions/ai-brain.js
// Human-friendly brain with Calendly-first CTA (no time-slot lists).
// Deterministic rules first; optional LLM fallback for classification only.
// decide({ text, agentName, calendlyLink, tz, officeHours, context, useLLM, llmMinConf })
// -> { text, intent, meta? }

// --- LLM (optional; safe stub if helper missing)
let llmClassify = async () => ({ intent: "", confidence: 0 });
try { llmClassify = require("./ai-brain-llm-helper").llmClassify; } catch {}
const LLM_ENABLED = String(process.env.AI_BRAIN_USE_LLM || "false").toLowerCase() === "true";
const LLM_MIN_CONF = Number(process.env.AI_BRAIN_LLM_CONFIDENCE || 0.55);

const DEFAULT_TZ = "America/Chicago";

/* ---------------- helpers ---------------- */
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const safe = (s) => (s ? String(s).trim() : "");

/* Reason bridge: generic life-insurance request (optional state mention) */
function reasonLine(ctx, es) {
  const state = safe(ctx?.state);
  if (es) return state ? `sobre su solicitud de seguro de vida en ${state}` : `sobre su solicitud de seguro de vida`;
  return state ? `about your life insurance request in ${state}` : `about your life insurance request`;
}

/* Calendly CTA: prefer clicks; gracefully omit if no link */
function linkLine(es, link) {
  if (!link) return "";
  return es
    ? ` Puede elegir la hora aquí para recibir recordatorios (y reprogramar si hace falta): ${link}`
    : ` You can pick a time here so you’ll get reminders (and can reschedule if needed): ${link}`;
}

/* Language detection */
function detectSpanish(t = "") {
  const s = String(t).toLowerCase();
  if (/[ñáéíóúü¿¡]/.test(s)) return true;
  const esHints = [
    "cuánto","cuanto","precio","costo","seguro","vida","mañana","manana",
    "tarde","noche","quien","quién","numero","número","ocupado","esposo","esposa",
    "hola","buenas","sí","si","vale","claro"
  ];
  let score = 0; for (const w of esHints) if (s.includes(w)) score++;
  return score >= 2;
}

/* Intent classification (rules first) */
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

  if (/\b(who(’|'|)s|whos)\s+this\??\b/.test(x) || /\bwho\s+is\s+this\??\b/.test(x) ||
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

  // Bare hour “7” without am/pm or minutes
  if (/\b([1-9]|1[0-2])\b/.test(x) && !/\b(am|pm)\b/.test(x) && !/\d:\d{2}/.test(x)) return "bare_hour";

  if (/^(hi|hey|hello|hola|buenas)\b/.test(x)) return "greet";

  return "general";
}

/* ---------------- Copy (Calendly-first, no time lists) ---------------- */
const T = {
  greetFirst: (es, n, link, ctx) => {
    const first = safe(ctx?.firstName);
    const reason = reasonLine(ctx, es);
    if (es) {
      const intro = first ? `Hola ${first}, soy ${n}.` : `Hola—soy ${n}.`;
      const soft  = `Le escribo ${reason}. Es rápido—solo unos minutos.`;
      return `${intro} ${soft} ¿Qué hora le queda mejor?${linkLine(es, link)}`;
    }
    const intro = first ? `Hey ${first}, it’s ${n}.` : `Hey—it’s ${n}.`;
    const soft  = `I’m reaching out ${reason}. It only takes a few minutes.`;
    return `${intro} ${soft} What time works best?${linkLine(es, link)}`;
  },

  greet: (es, n, link, ctx) => {
    const first = safe(ctx?.firstName);
    const reason = reasonLine(ctx, es);
    if (es) {
      const open = first ? `Hola ${first},` : `Hola,`;
      const soft = `le escribo ${reason}. Son solo unos minutos.`;
      return `${open} soy ${n}. ${soft} ¿Qué hora le conviene?${linkLine(es, link)}`;
    }
    const open = first ? `Hey ${first},` : `Hi there,`;
    const soft = `I’m reaching out ${reason}. Just a few minutes.`;
    return `${open} it’s ${n}. ${soft} What time’s easiest?${linkLine(es, link)}`;
  },

  courtesy: (es, n, link, ctx) => {
    const reason = reasonLine(ctx, es);
    if (es) {
      const start = pick([`¡Bien, gracias!`, `Todo bien, gracias.`]);
      return `${start} Le escribo ${reason}. Es rápido—unos minutos. ¿Qué hora le conviene?${linkLine(es, link)}`;
    }
    const start = pick([`Doing well, thanks!`, `All good—thanks for asking.`]);
    return `${start} I’m reaching out ${reason}. It’s quick—just a few minutes. What time works for you?${linkLine(es, link)}`;
  },

  who: (es, n, link, ctx) => {
    const first = safe(ctx?.firstName);
    const reason = reasonLine(ctx, es);
    if (es) {
      const intro = first ? `Hola ${first}, soy ${n}.` : `Hola, soy ${n}.`;
      const soft  = `Usted nos contactó ${reason}. Es una revisión corta.`;
      return `${intro} ${soft} ¿Qué hora le queda mejor?${linkLine(es, link)}`;
    }
    const intro = first ? `Hey ${first}, this is ${n}.` : `Hey, this is ${n}.`;
    const soft  = `You reached out ${reason}. It’s a quick review.`;
    return `${intro} ${soft} What time works best?${linkLine(es, link)}`;
  },

  price: (es, link) =>
    es
      ? `Buena pregunta—el costo depende de edad, salud y cobertura. Lo vemos rápido por teléfono. ¿Qué hora le conviene?${linkLine(es, link)}`
      : `Great question—price depends on age, health, and coverage. Easiest is a quick call. What time works for you?${linkLine(es, link)}`,

  covered: (es, link) =>
    es
      ? `Perfecto. Aun así, una revisión corta ayuda a no pagar de más ni perder beneficios. ¿Qué hora le conviene?${linkLine(es, link)}`
      : `Nice—many still do a quick review to avoid overpaying or missing benefits. What time works best?${linkLine(es, link)}`,

  brushoff: (es, link) =>
    es
      ? `Entiendo. Lo hacemos rápido y sin complicaciones. ¿Qué hora le conviene?${linkLine(es, link)}`
      : `Totally get it—happy to keep it quick and simple. What time works for you?${linkLine(es, link)}`,

  spouse: (es, link) =>
    es
      ? `De acuerdo—mejor cuando estén ambos. ¿Qué hora les queda mejor?${linkLine(es, link)}`
      : `Makes sense—best when you’re both on. What time works for you two?${linkLine(es, link)}`,

  wrong: (es) =>
    es ? `Sin problema. Si desea ver opciones más adelante, avíseme.` : `No worries. If you want to look at options later, just text me.`,

  agree: (es, link) =>
    es ? `Perfecto—¿qué hora le conviene?${linkLine(es, link)}` : `Great—what time works best for you?${linkLine(es, link)}`,

  timeConfirm: (es, label, link) =>
    es ? `Perfecto, le llamo a las ${label}. Lo mantengo breve.${link ? " " + linkLine(es, link) : ""}`
       : `Perfect, I’ll call you at ${label}. I’ll keep it quick.${link ? " " + linkLine(es, link) : ""}`,

  clarifyTime: (es, h, link) =>
    es ? `¿Le queda mejor ${h} AM o ${h} PM?${link ? " " + linkLine(es, link) : ""}`
       : `Does ${h} work better AM or PM?${link ? " " + linkLine(es, link) : ""}`,

  reschedule: (es, link) =>
    es ? `Claro—reprogramemos. ¿Qué hora le conviene?${linkLine(es, link)}`
       : `Absolutely—let’s reschedule. What time works better?${linkLine(es, link)}`,
};

/* ---------------- Decide ---------------- */
async function decide({ text, agentName, calendlyLink, tz, officeHours, context, useLLM, llmMinConf } = {}) {
  tz = tz || DEFAULT_TZ;
  const es = detectSpanish(text);
  const name = agentName || (es ? "su corredor autorizado" : "your licensed broker");

  const intentDet = classify(text);

  if (intentDet === "stop") {
    return { text: "", intent: "stop", meta: { route: "deterministic" } };
  }

  // Special: "how are you?"
  if (intentDet === "courtesy_greet") {
    return { text: T.courtesy(es, name, calendlyLink, context), intent: "courtesy_greet", meta: { route: "deterministic" } };
  }

  // Time-specific (confirm exact time) — handle “noon”
  if (/\bnoon\b/i.test(text)) {
    return { text: T.timeConfirm(es, "12 PM", calendlyLink), intent: "confirm_time", meta: { route: "deterministic" } };
  }
  if (intentDet === "time_specific") {
    const m = String(text).match(/\b(1?\d(?::\d{2})?\s?(a\.?m\.?|p\.?m\.?|am|pm))\b/i) || String(text).match(/\b(1?\d:\d{2})\b/);
    const label = m ? m[1].toUpperCase().replace(/\s+/g, " ") : "the time we discussed";
    return { text: T.timeConfirm(es, label, calendlyLink), intent: "confirm_time", meta: { route: "deterministic" } };
  }

  // Bare hour like "7" → clarify AM/PM
  if (intentDet === "bare_hour") {
    const h = String(text).match(/\b([1-9]|1[0-2])\b/)[1];
    return { text: T.clarifyTime(es, h, calendlyLink), intent: "clarify_time", meta: { route: "deterministic" } };
  }

  // Time window — no slot suggestions
  if (intentDet === "time_window") {
    const lead = es ? `Perfecto.` : `That works.`;
    const ask = es ? ` ¿Qué hora le conviene?` : ` What time’s easiest for you?`;
    return { text: `${lead}${ask}${linkLine(es, calendlyLink)}`, intent: "offer_slots_windowed", meta: { route: "deterministic" } };
  }

  // Direct mappings (Calendly-first)
  if (intentDet === "reschedule") return { text: T.reschedule(es, calendlyLink), intent: "reschedule", meta: { route: "deterministic" } };

  if (intentDet === "greet") {
    const firstTurn = context?.firstTurn === true;
    if (firstTurn) return { text: T.greetFirst(es, name, calendlyLink, context), intent: "greet_first_turn", meta: { route: "deterministic" } };
    return { text: T.greet(es, name, calendlyLink, context), intent: "greet", meta: { route: "deterministic" } };
  }

  if (intentDet === "who")      return { text: T.who(es, name, calendlyLink, context), intent: "who", meta: { route: "deterministic" } };
  if (intentDet === "price")    return { text: T.price(es, calendlyLink), intent: "price", meta: { route: "deterministic" } };
  if (intentDet === "covered")  return { text: T.covered(es, calendlyLink), intent: "covered", meta: { route: "deterministic" } };
  if (intentDet === "brushoff") return { text: T.brushoff(es, calendlyLink), intent: "brushoff", meta: { route: "deterministic" } };
  if (intentDet === "spouse")   return { text: T.spouse(es, calendlyLink), intent: "spouse", meta: { route: "deterministic" } };
  if (intentDet === "wrong")    return { text: T.wrong(es), intent: "wrong", meta: { route: "deterministic" } };
  if (intentDet === "callme")   return { text: T.greet(es, name, calendlyLink, context), intent: "callme", meta: { route: "deterministic" } };
  if (intentDet === "agree")    return { text: T.agree(es, calendlyLink), intent: "agree", meta: { route: "deterministic" } };

  // ---------- LLM fallback (classification only) ----------
  const wantLLM = typeof useLLM === "boolean" ? useLLM : LLM_ENABLED;
  const minConf = typeof llmMinConf === "number" ? llmMinConf : LLM_MIN_CONF;

  if (wantLLM) {
    const llm = await llmClassify(text);
    if (llm.confidence >= minConf) {
      const intent = llm.intent;

      if (intent === "time_specific" && llm.time?.type === "specific" && llm.time.value) {
        return { text: T.timeConfirm(es, llm.time.value, calendlyLink), intent: "confirm_time", meta: { route: "llm", conf: llm.confidence } };
      }
      if (intent === "time_window") {
        const lead = es ? `Perfecto.` : `That works.`;
        const ask = es ? ` ¿Qué hora le conviene?` : ` What time’s easiest for you?`;
        return { text: `${lead}${ask}${linkLine(es, calendlyLink)}`, intent: "offer_slots_windowed", meta: { route: "llm", conf: llm.confidence } };
      }

      if (intent === "courtesy_greet") return { text: T.courtesy(es, name, calendlyLink, context), intent, meta: { route: "llm", conf: llm.confidence } };
      if (intent === "greet")          return { text: T.greet(es, name, calendlyLink, context),    intent, meta: { route: "llm", conf: llm.confidence } };
      if (intent === "who")            return { text: T.who(es, name, calendlyLink, context),      intent, meta: { route: "llm", conf: llm.confidence } };
      if (intent === "price")          return { text: T.price(es, calendlyLink),                   intent, meta: { route: "llm", conf: llm.confidence } };
      if (intent === "covered")        return { text: T.covered(es, calendlyLink),                 intent, meta: { route: "llm", conf: llm.confidence } };
      if (intent === "brushoff")       return { text: T.brushoff(es, calendlyLink),                intent, meta: { route: "llm", conf: llm.confidence } };
      if (intent === "spouse")         return { text: T.spouse(es, calendlyLink),                  intent, meta: { route: "llm", conf: llm.confidence } };
      if (intent === "wrong")          return { text: T.wrong(es),                                 intent, meta: { route: "llm", conf: llm.confidence } };
      if (intent === "callme")         return { text: T.greet(es, name, calendlyLink, context),    intent, meta: { route: "llm", conf: llm.confidence } };
      if (intent === "agree")          return { text: T.agree(es, calendlyLink),                   intent, meta: { route: "llm", conf: llm.confidence } };
    }
  }

  // Fallback general
  const firstTurn = context?.firstTurn === true;
  if (firstTurn) return { text: T.greetFirst(es, name, calendlyLink, context), intent: "greet_first_turn", meta: { route: "fallback" } };
  return { text: T.greet(es, name, calendlyLink, context), intent: "offer_slots", meta: { route: "fallback" } };
}

module.exports = { decide };
