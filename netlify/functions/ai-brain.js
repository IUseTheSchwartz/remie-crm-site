// Hybrid brain: deterministic rules first; optional Groq fallback for classification only.
// Exports: decide({ text, agentName, calendlyLink, tz, officeHours, context, useLLM, llmMinConf }) -> { text, intent, meta? }

// ---- SAFE LLM IMPORT (won't crash if helper/env missing)
let llmClassify = async () => ({ intent: "", confidence: 0 });
try { llmClassify = require("./ai-brain-llm-helper").llmClassify; } catch {}

const DEFAULT_TZ = "America/Chicago";
const DEFAULT_HOURS = { start: 9, end: 21 }; // inclusive local window
const LLM_ENABLED = String(process.env.AI_BRAIN_USE_LLM || "false").toLowerCase() === "true";
const LLM_MIN_CONF = Number(process.env.AI_BRAIN_LLM_CONFIDENCE || 0.55);

/* ---------------- helpers ---------------- */
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const safe = (s) => (s ? String(s).trim() : "");
const normalize = (t = "") => String(t).trim().toLowerCase().replace(/\s+/g, " ");

/* ---------------- language ---------------- */
function detectSpanish(t = "") {
  const s = String(t).toLowerCase();
  if (/[ñáéíóúü¿¡]/.test(s)) return true;
  const hints = ["cuánto","cuanto","precio","costo","seguro","vida","mañana","manana","tarde","noche","quien","quién","numero","número","equivocado","esposo","esposa","si","sí","vale","claro","buenas","hola"];
  let score = 0; for (const w of hints) if (s.includes(w)) score++;
  return score >= 2;
}

/* ---------------- intents (deterministic) ---------------- */
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

/* ---------------- time parsing helpers ---------------- */
function hasAmbiguousBareHour(t) {
  const x = normalize(t);
  const m = x.match(/\b([1-9]|1[0-2])\b/);
  if (!m) return false;
  if (/\b(am|pm)\b/.test(x) || /\d:\d{2}/.test(x)) return false;
  if (/\bafter\s+[1-9]|1[0-2]\b/.test(x)) return false;
  return true;
}

/* ---------------- copy (no time-slot offers) ---------------- */
const T = {
  // Generic “brand link” helper
  linkLine: (es, link) =>
    link
      ? (es
          ? ` Puede elegir un horario aquí: ${link}`
          : ` You can grab a time here: ${link}`)
      : "",

  greetGeneral: (es, n, link) =>
    es
      ? `Hola—soy ${n}. Sobre su solicitud de seguro de vida—esto toma solo unos minutos.${T.linkLine(es, link)} ¿Qué hora le funciona?`
      : `Hi there—it’s ${n}. About your life-insurance request—this only takes a few minutes.${T.linkLine(es, link)} What time works for you?`,

  who: (es, n, link) =>
    es
      ? `Hola, soy ${n}. Usted solicitó información de seguro de vida recientemente. Podemos verlo rápido.${T.linkLine(es, link)} ¿Qué hora le conviene?`
      : `Hey, this is ${n}. You recently requested info about life insurance. We can review it quickly.${T.linkLine(es, link)} What time works for you?`,

  price: (es, link) =>
    es
      ? `Buena pregunta—depende de edad, salud y cobertura. Lo más fácil es una llamada corta.${T.linkLine(es, link)} ¿Qué hora prefiere?`
      : `Great question—it depends on age, health, and coverage. Easiest is a quick call.${T.linkLine(es, link)} What time works for you?`,

  covered: (es, link) =>
    es
      ? `Genial. Aun así, muchos hacen una revisión corta para no pagar de más ni perder beneficios.${T.linkLine(es, link)} ¿Qué hora le conviene?`
      : `Good to hear. Folks still do a quick review to make sure they’re not overpaying or missing benefits.${T.linkLine(es, link)} What time works for you?`,

  brushoff: (es, link) =>
    es
      ? `Entiendo—lo mantenemos breve.${T.linkLine(es, link)} ¿Qué hora le funciona?`
      : `Totally get it—we’ll keep it quick.${T.linkLine(es, link)} What time works for you?`,

  spouse: (es, link) =>
    es
      ? `De acuerdo—mejor cuando estén ambos.${T.linkLine(es, link)} ¿Qué hora les conviene?`
      : `Makes sense—best when you’re both on.${T.linkLine(es, link)} What time works for you two?`,

  wrong: (es) =>
    es ? `Sin problema—si más adelante quiere revisar opciones, me avisa.` : `No worries—if you want to look at options later, just text me.`,

  agree: (es, link) =>
    es
      ? `Perfecto—lo dejamos rápido.${T.linkLine(es, link)} ¿Qué hora le conviene?`
      : `Great—let’s keep it quick.${T.linkLine(es, link)} What time works for you?`,

  // time handling
  timeConfirm: (es, label, link) =>
    es
      ? `Perfecto, le llamo a las ${label}. Lo mantengo breve.${link ? ` Si prefiere, confirme aquí para recordatorios o reprogramar: ${link}` : ""}`
      : `Perfect, I’ll call you at ${label}. I’ll keep it quick.${link ? ` If you’d like reminders or to reschedule, here’s a quick link: ${link}` : ""}`,

  clarifyTime: (es, h) =>
    es ? `¿Le queda mejor ${h} AM o ${h} PM?` : `Does ${h} work better AM or PM?`,

  courtesy: (es, n, link) =>
    es
      ? `¡Bien, gracias!${T.linkLine(es, link)} ¿Qué hora le conviene?`
      : `Doing well, thanks!${T.linkLine(es, link)} What time works for you?`,
};

/* ---------------- decide ---------------- */
async function decide({
  text,
  agentName,
  calendlyLink, // we pass the agent-site link here
  tz,
  officeHours,
  context,
  useLLM,
  llmMinConf,
} = {}) {
  tz = tz || DEFAULT_TZ;
  const es = detectSpanish(text);
  const name = agentName || (es ? "su corredor autorizado" : "your licensed broker");
  const link = (calendlyLink || "").trim();

  const intentDet = classify(text);

  // STOP: return no text; upstream inbound handler can manage compliance
  if (intentDet === "stop") return { text: "", intent: "stop", meta: { route: "deterministic" } };

  // Courtesy “how are you”
  if (intentDet === "courtesy_greet") {
    return { text: T.courtesy(es, name, link), intent: "courtesy_greet", meta: { route: "deterministic" } };
  }

  // Specific clock time (and “noon”)
  if (/\bnoon\b/i.test(text)) {
    return { text: T.timeConfirm(es, "12 PM", link), intent: "confirm_time", meta: { route: "deterministic" } };
  }
  if (intentDet === "time_specific") {
    const m =
      String(text).match(/\b(1?\d(?::\d{2})?\s?(a\.?m\.?|p\.?m\.?|am|pm))\b/i) ||
      String(text).match(/\b(1?\d:\d{2})\b/);
    const label = m ? m[1].toUpperCase().replace(/\s+/g, " ") : "the time we discussed";
    return { text: T.timeConfirm(es, label, link), intent: "confirm_time", meta: { route: "deterministic" } };
  }

  // Bare hour like “7” → clarify AM/PM
  if (hasAmbiguousBareHour(text)) {
    const h = String(text).match(/\b([1-9]|1[0-2])\b/)[1];
    return { text: T.clarifyTime(es, h), intent: "clarify_time", meta: { route: "deterministic" } };
  }

  // Time window → acknowledge, but no slot list
  if (intentDet === "time_window") {
    return {
      text: es
        ? `Esa franja me funciona. ${T.linkLine(es, link).trimStart()} ¿Qué hora específica le queda mejor?`
        : `That window works for me.${T.linkLine(es, link)} What specific time is best for you?`,
      intent: "time_window_ack",
      meta: { route: "deterministic" },
    };
  }

  // Direct mappings (no slot menus; always human + CTA when link exists)
  if (intentDet === "greet")     return { text: T.greetGeneral(es, name, link), intent: "greet",    meta: { route: "deterministic" } };
  if (intentDet === "who")       return { text: T.who(es, name, link),          intent: "who",      meta: { route: "deterministic" } };
  if (intentDet === "price")     return { text: T.price(es, link),              intent: "price",    meta: { route: "deterministic" } };
  if (intentDet === "covered")   return { text: T.covered(es, link),            intent: "covered",  meta: { route: "deterministic" } };
  if (intentDet === "brushoff")  return { text: T.brushoff(es, link),           intent: "brushoff", meta: { route: "deterministic" } };
  if (intentDet === "spouse")    return { text: T.spouse(es, link),             intent: "spouse",   meta: { route: "deterministic" } };
  if (intentDet === "wrong")     return { text: T.wrong(es),                    intent: "wrong",    meta: { route: "deterministic" } };
  if (intentDet === "callme")    return { text: T.greetGeneral(es, name, link), intent: "callme",   meta: { route: "deterministic" } };
  if (intentDet === "agree")     return { text: T.agree(es, link),              intent: "agree",    meta: { route: "deterministic" } };

  // -------- LLM fallback (classification only, no text generation) --------
  const wantLLM = typeof useLLM === "boolean" ? useLLM : LLM_ENABLED;
  const minConf = typeof llmMinConf === "number" ? llmMinConf : LLM_MIN_CONF;

  if (wantLLM) {
    const llm = await llmClassify(text);
    if (llm.confidence >= minConf) {
      const intent = llm.intent;

      if (intent === "time_specific" && llm.time?.type === "specific" && llm.time.value) {
        return { text: T.timeConfirm(es, llm.time.value, link), intent: "confirm_time", meta: { route: "llm", conf: llm.confidence } };
      }
      if (intent === "time_window" && llm.time?.type === "window") {
        return {
          text: es
            ? `Esa franja me funciona. ${T.linkLine(es, link).trimStart()} ¿Qué hora específica le queda mejor?`
            : `That window works for me.${T.linkLine(es, link)} What specific time is best for you?`,
          intent: "time_window_ack",
          meta: { route: "llm", conf: llm.confidence },
        };
      }

      if (intent === "courtesy_greet") return { text: T.courtesy(es, name, link),         intent, meta: { route: "llm", conf: llm.confidence } };
      if (intent === "greet")          return { text: T.greetGeneral(es, name, link),     intent, meta: { route: "llm", conf: llm.confidence } };
      if (intent === "who")            return { text: T.who(es, name, link),              intent, meta: { route: "llm", conf: llm.confidence } };
      if (intent === "price")          return { text: T.price(es, link),                  intent, meta: { route: "llm", conf: llm.confidence } };
      if (intent === "covered")        return { text: T.covered(es, link),                intent, meta: { route: "llm", conf: llm.confidence } };
      if (intent === "brushoff")       return { text: T.brushoff(es, link),               intent, meta: { route: "llm", conf: llm.confidence } };
      if (intent === "spouse")         return { text: T.spouse(es, link),                 intent, meta: { route: "llm", conf: llm.confidence } };
      if (intent === "wrong")          return { text: T.wrong(es),                        intent, meta: { route: "llm", conf: llm.confidence } };
      if (intent === "callme")         return { text: T.greetGeneral(es, name, link),     intent, meta: { route: "llm", conf: llm.confidence } };
      if (intent === "agree")          return { text: T.agree(es, link),                  intent, meta: { route: "llm", conf: llm.confidence } };
    }
  }

  // Fallback: natural greet with CTA
  return { text: T.greetGeneral(es, name, link), intent: "greet", meta: { route: "fallback" } };
}

module.exports = { decide };
