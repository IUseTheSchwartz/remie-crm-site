// File: netlify/functions/ai-brain.js
// Hybrid conversational brain: rules-first, then optional LLM classification + short LLM reply.
// Exports: decide({ text, agentName, agentSite, agentPhone, agentEmail, tz, officeHours, context, useLLM, useLLMReply, llmMinConf })
//   -> { text, intent, meta?, action? }

let llmClassify = async () => ({ intent: "", confidence: 0, lang: "en" });
let llmReply = async () => ({ text: "", confidence: 0, reasons: [] });
try {
  const helper = require("./ai-brain-llm-helper");
  if (helper.llmClassify) llmClassify = helper.llmClassify;
  if (helper.llmReply) llmReply = helper.llmReply; // optional; safe if missing
} catch {}

const DEFAULT_TZ = "America/Chicago";
const DEFAULT_HOURS = { start: 9, end: 21 };

const LLM_ENABLED = String(process.env.AI_BRAIN_USE_LLM || "false").toLowerCase() === "true";
const LLM_MIN_CONF = Number(process.env.AI_BRAIN_LLM_CONFIDENCE || 0.55);
const LLM_REPLY_ENABLED = String(process.env.AI_BRAIN_USE_LLM_REPLY || "false").toLowerCase() === "true";
const LLM_REPLY_MAXTOKENS = Number(process.env.AI_BRAIN_LLM_REPLY_MAXTOKENS || 140);

/* ---------------- helpers ---------------- */
const safe = (s) => (s ? String(s).trim() : "");
const normalize = (t = "") => String(t).trim().toLowerCase().replace(/\s+/g, " ");
const withinOffice = (hours = DEFAULT_HOURS, hour) =>
  hour >= Number(hours.start ?? 9) && hour <= Number(hours.end ?? 21);

function shortDateTodayInTZ(tz = DEFAULT_TZ, es = false) {
  const d = new Date();
  const fmt = new Intl.DateTimeFormat(es ? "es-US" : "en-US", {
    timeZone: tz,
    month: "short",
    day: "numeric",
  });
  return fmt.format(d);
}

/* ---------------- language ---------------- */
function detectSpanish(t = "") {
  const s = String(t).toLowerCase();
  if (/[ñáéíóúü¿¡]/.test(s)) return true;
  const hints = [
    "cuánto","cuanto","precio","costo","seguro","vida","mañana","manana",
    "tarde","noche","quien","quién","numero","número","equivocado","esposo",
    "esposa","si","sí","vale","claro","buenas","hola","cotización","cotizacion","cotizaciones"
  ];
  let score = 0; for (const w of hints) if (s.includes(w)) score++;
  return score >= 2;
}

/* ---------------- intents (deterministic) ---------------- */
function classify(t = "") {
  const x = normalize(t);
  if (!x) return "general";

  // hard filters first
  if (/\b(stop|unsubscribe|quit|cancel|end)\b/.test(x)) return "stop";
  if (/\bwrong number|not (me|my number)\b/.test(x) || /\bn[uú]mero equivocado\b/.test(x)) return "wrong";

  // courtesy / greetings / acks
  if (/\b(how are you|how’s it going|how's it going|hru|how are u|how r you)\b/.test(x)) return "courtesy_greet";
  if (/^(k|kk|kay|ok(ay)?|sure|sounds good|works|perfect|great|cool|yep|yeah|si|sí|vale|dale|va|👍|👌)\b/.test(x)) return "agree";
  if (/^(nah|nope|not now|no)\b/.test(x)) return "brushoff";
  if (/^(hi|hey|hello|hola|buenas)\b/.test(x)) return "greet";

  // verification / hostility / bot skepticism
  if (/\b(sc(am|ammers?)|legit|real person|are you (a )?bot|spam|fraud|fake|robot)\b/.test(x)) return "verify";

  // pricing / quotes / estimates
  if (/\b(price|how much|cost|monthly|payment|premium|quotes?|estimate|estimates?|rate|rates?)\b/.test(x) ||
      /\b(cu[áa]nto|precio|costo|pago|mensual|cuota|prima|cotizaci[oó]n|cotizaciones)\b/.test(x)) return "price";

  // who / why texting
  if (/\bwho('?|’)?s\s+this\??\b/.test(x) ||
      /\bwho\s+is\s+this\??\b/.test(x) ||
      /\bwho are you\??\b/.test(x) ||
      /\bhow did you get (my|this) (number|#)\b/.test(x) ||
      /\bwhy (are|r) you texting\b/.test(x) ||
      /\bqui[eé]n (eres|habla|manda|me escribe)\b/.test(x)) return "who";

  // status
  if (/\b(already have|i have insurance|covered|i'?m covered|policy already|i'm good)\b/.test(x) ||
      /\b(ya tengo|tengo seguro|ya estoy cubiert[oa])\b/.test(x)) return "covered";

  // brushoff
  if (/\b(not interested|leave me alone|busy|working|at work|later|another time|no thanks)\b/.test(x) ||
      /\b(no me interesa|ocupad[oa]|luego|m[aá]s tarde|otro d[ií]a)\b/.test(x)) return "brushoff";

  // spouse
  if (/\b(spouse|wife|husband|partner)\b/.test(x) || /\bespos[ao]\b/.test(x)) return "spouse";

  // call requests
  if (/\b(call|ring|phone me|give me a call|ll[aá]mame|llamar)\b/.test(x)) return "callme";

  // reschedule
  if (/\b(resched|re[- ]?schedule|different time|change (the )?time|move (it|appt)|new time)\b/i.test(x) ||
      /\b(reprogramar|cambiar hora|otra hora|mover la cita)\b/.test(x)) return "reschedule";

  // time windows & specifics
  if (/\b(tom(orrow)?|today|evening|afternoon|morning|tonight|this (afternoon|evening|morning)|after\s+\d{1,2})\b/.test(x) ||
      /\b(ma[ñn]ana|hoy|tarde|noche|despu[eé]s de\s+\d{1,2})\b/.test(x)) return "time_window";
  if (/\b(1?\d(?::\d{2})?\s?(a\.?m\.?|p\.?m\.?|am|pm))\b/.test(x) || /\b(1?\d:\d{2})\b/.test(x) || /\bnoon\b/.test(x)) return "time_specific";

  // info by text
  if (/\b(text (me )?(info|details)|send (me )?(info|details|the link|website|site|page)|just text( it)?|can you text)\b/.test(x) ||
      /\b(info|details|link|site|website|page)\b/.test(x)) return "info";

  // can't talk
  if (/\b(can'?t|cannot|won'?t) (talk|chat|speak)|in a meeting|driving|on (a )?call|now isn'?t good|text only\b/.test(x)) return "cant_talk";

  // how long
  if (/\b(how long|how many minutes|quick call\??|time does it take)\b/.test(x) ||
      /\b(cu[aá]nto tarda|cu[aá]ntos minutos|es r[aá]pido)\b/.test(x)) return "how_long";

  return "general";
}

/* ---------------- time helpers ---------------- */
function hasAmbiguousBareHour(t) {
  const x = normalize(t);
  const m = x.match(/\b([1-9]|1[0-2])\b/);
  if (!m) return false;
  if (/\b(am|pm)\b/.test(x) || /\d:\d{2}/.test(x)) return false;
  if (/\bafter\s+[1-9]|1[0-2]\b/.test(x)) return false;
  return true;
}
function isAMPMOnly(t = "") { return /^\s*(a\.?m\.?|p\.?m\.?|am|pm)\s*$/i.test(String(t || "")); }

/* ---------------- gated helper lines ---------------- */
const lines = {
  linkLine: (es, link, show) =>
    show && link ? (es ? ` Puede elegir un horario aquí: ${link}` : ` You can grab a time here: ${link}`) : "",
  verifyLine: (es, link, show) =>
    show && link ? (es
      ? ` Mientras tanto, si desea verificar mis credenciales, puede visitar mi sitio: ${link}`
      : ` In the meantime, if you’d like to verify my credentials, you can visit my website: ${link}`) : ""
};

/* ---------------- copy ---------------- */
const T = {
  greetGeneral: (es, n, link, opts = {}) =>
    es
      ? `Hola—soy ${n}. Sobre su solicitud de seguro de vida—esto toma solo unos minutos.` +
        lines.linkLine(es, link, !!opts.firstTurn) +
        ` ¿Qué hora le funciona?` +
        lines.verifyLine(es, link, !!opts.firstTurn)
      : `Hi there—it’s ${n}. About your life-insurance request—this only takes a few minutes.` +
        lines.linkLine(es, link, !!opts.firstTurn) +
        ` What time works for you?` +
        lines.verifyLine(es, link, !!opts.firstTurn),

  who: (es, n, link, opts = {}) =>
    es
      ? `Hola, soy ${n}. Usted solicitó información de seguro de vida recientemente. Podemos verlo rápido.` +
        lines.linkLine(es, link, !!opts.firstTurn) +
        ` ¿Qué hora le conviene?` +
        lines.verifyLine(es, link, !!opts.firstTurn)
      : `Hey, this is ${n}. You recently requested info about life insurance. We can review it quickly.` +
        lines.linkLine(es, link, !!opts.firstTurn) +
        ` What time works for you?` +
        lines.verifyLine(es, link, !!opts.firstTurn),

  // UPDATED: removed beneficiary dependency
  price: (es, link, opts = {}) =>
    es
      ? `Claro—las cifras dependen sobre todo de su edad y salud. Es una llamada breve de 5–7 min.` +
        lines.linkLine(es, link, !!opts.firstTurn) +
        ` ¿Qué hora le queda mejor?`
      : `Totally—exact numbers mainly depend on age and health. It’s a quick 5–7 min call.` +
        lines.linkLine(es, link, !!opts.firstTurn) +
        ` What time works for you?`,

  covered: (es, link, opts = {}) =>
    es
      ? `Genial. Igual conviene una revisión corta para no pagar de más ni perder beneficios.` +
        lines.linkLine(es, link, !!opts.firstTurn) +
        ` ¿Qué hora le conviene?`
      : `Good to hear. Folks still do a quick review so they’re not overpaying or missing benefits.` +
        lines.linkLine(es, link, !!opts.firstTurn) +
        ` What time works for you?`,

  brushoff: (es, link, opts = {}) =>
    es
      ? `Entiendo—lo mantenemos breve.` + lines.linkLine(es, link, !!opts.firstTurn) + ` ¿Qué hora le funciona?`
      : `Totally get it—we’ll keep it quick.` + lines.linkLine(es, link, !!opts.firstTurn) + ` What time works for you?`,

  spouse: (es, link, opts = {}) =>
    es
      ? `De acuerdo—mejor cuando estén ambos.` + lines.linkLine(es, link, !!opts.firstTurn) + ` ¿Qué hora les conviene?`
      : `Makes sense—best when you’re both on.` + lines.linkLine(es, link, !!opts.firstTurn) + ` What time works for you two?`,

  wrong: (es) =>
    es ? `Sin problema—si más adelante quiere revisar opciones, me avisa.` : `No worries—if you want to look at options later, just text me.`,

  agree: (es, link, opts = {}) =>
    es
      ? `Perfecto—lo dejamos rápido.` + lines.linkLine(es, link, !!opts.firstTurn) + ` ¿Qué hora le conviene?`
      : `Great—let’s keep it quick.` + lines.linkLine(es, link, !!opts.firstTurn) + ` What time works for you?`,

  verify: (es, n, link, opts = {}) =>
    es
      ? `Pregunta válida—soy ${n}, corredor autorizado. Hago seguimiento a su solicitud de seguro de vida.` +
        lines.linkLine(es, link, !!opts.firstTurn) + ` ¿Qué hora le funciona?` + lines.verifyLine(es, link, !!opts.firstTurn)
      : `Fair question—this is ${n}, a licensed broker. I’m following up on your life-insurance request.` +
        lines.linkLine(es, link, !!opts.firstTurn) + ` What time works for you?` + lines.verifyLine(es, link, !!opts.firstTurn),

  info: (es, link, opts = {}) =>
    es
      ? `Puedo enviar lo básico por aquí—en la llamada confirmamos lo necesario para cifras reales.` +
        lines.linkLine(es, link, !!opts.firstTurn) + ` ¿Qué hora prefiere?`
      : `I can text the basics here—on a quick call we confirm what’s needed for exact numbers.` +
        lines.linkLine(es, link, !!opts.firstTurn) + ` What time works for you?`,

  cant_talk: (es, link, opts = {}) =>
    es
      ? `Sin problema, lo coordinamos.` + lines.linkLine(es, link, !!opts.firstTurn) + ` ¿Qué hora más tarde le queda mejor?`
      : `No problem—let’s line it up.` + lines.linkLine(es, link, !!opts.firstTurn) + ` What time later today works best?`,

  how_long: (es, link, opts = {}) =>
    es
      ? `Solo 5–7 minutos para salud básica y presupuesto, y darle opciones claras.` +
        lines.linkLine(es, link, !!opts.firstTurn) + ` ¿Qué hora le conviene?`
      : `Just 5–7 minutes to cover basic health and budget so we can show clear options.` +
        lines.linkLine(es, link, !!opts.firstTurn) + ` What time works for you?`,

  // Confirmation (ALWAYS includes verify line)
  timeConfirm: (es, label, link, tz) => {
    const d = shortDateTodayInTZ(tz, es);
    const verifyLine = link
      ? (es
          ? ` Mientras tanto, si desea verificar mis credenciales, puede visitar mi sitio: ${link}`
          : ` In the meantime, if you’d like to verify my credentials, you can visit my website: ${link}`)
      : "";
    return es
      ? `Para confirmar—le llamo a las ${label} hoy (${d}). Si necesita reprogramar, envíeme un texto 30–60 minutos antes de nuestra cita.${verifyLine}`
      : `Just to make sure—I’ll call you at ${label} today (${d}). If you need to reschedule, just text me 30–60 minutes before our appointment.${verifyLine}`;
  },

  clarifyTime: (es, h) => (es ? `¿Le queda mejor ${h} AM o ${h} PM?` : `Does ${h} work better AM or PM?`),

  courtesy: (es, n, link, opts = {}) =>
    es
      ? `¡Bien, gracias!` + lines.linkLine(es, link, !!opts.firstTurn) + ` ¿Qué hora le conviene?`
      : `Doing well, thanks!` + lines.linkLine(es, link, !!opts.firstTurn) + ` What time works for you?`,
};

/* ---------------- planner ---------------- */
function planNext({ intent, text, es, link, name, context, tz }) {
  const firstTurn = !!(context && context.firstTurn);

  // AM/PM follow-up from last turn
  if (isAMPMOnly(text) && context?.promptedHour) {
    const ampm = /p/i.test(text) ? "PM" : "AM";
    const label = `${context.promptedHour} ${ampm}`;
    return {
      text: T.timeConfirm(es, label, link, tz),
      intent: "confirm_time",
      meta: {
        route: "context_am_pm",
        time_label: label,
        context_patch: { promptedHour: null, last_intent: "confirm_time" },
      }
    };
  }

  // Specific clock time & "noon"
  if (/\bnoon\b/i.test(text)) {
    const label = "12 PM";
    return {
      text: T.timeConfirm(es, label, link, tz),
      intent: "confirm_time",
      meta: {
        route: "deterministic",
        time_label: label,
        context_patch: { promptedHour: null, last_intent: "confirm_time" },
      }
    };
  }
  if (intent === "time_specific") {
    const m =
      String(text).match(/\b(1?\d(?::\d{2})?\s?(a\.?m\.?|p\.?m\.?|am|pm))\b/i) ||
      String(text).match(/\b(1?\d:\d{2})\b/);
    const label = m ? m[1].toUpperCase().replace(/\s+/g, " ") : "the time we discussed";
    return {
      text: T.timeConfirm(es, label, link, tz),
      intent: "confirm_time",
      meta: {
        route: "deterministic",
        time_label: label,
        context_patch: { promptedHour: null, last_intent: "confirm_time" },
      }
    };
  }

  // Bare hour → clarify AM/PM and remember
  if (hasAmbiguousBareHour(text)) {
    const h = String(text).match(/\b([1-9]|1[0-2])\b/)[1];
    return {
      text: T.clarifyTime(es, h),
      intent: "clarify_time",
      meta: { route: "deterministic", prompt_hour: h, context_patch: { promptedHour: h, last_intent: "clarify_time" } }
    };
  }

  // Time window → ask for a specific time
  if (intent === "time_window") {
    return {
      text: es
        ? `Esa franja me funciona.` + lines.linkLine(es, link, firstTurn) + ` ¿Qué hora específica le queda mejor?`
        : `That window works for me.` + lines.linkLine(es, link, firstTurn) + ` What specific time is best for you?`,
      intent: "time_window_ack",
      meta: { route: "deterministic", context_patch: { last_intent: "time_window_ack" } },
    };
  }

  // Directs (note: pass firstTurn to gate link/verify on first message only)
  if (intent === "stop")       return { text: "", intent: "stop", meta: { route: "deterministic", context_patch: { last_intent: "stop" } }, action: "opt_out" };
  if (intent === "wrong")      return { text: T.wrong(es), intent: "wrong", meta: { route: "deterministic", context_patch: { last_intent: "wrong" } }, action: "tag_wrong_number" };
  if (intent === "greet")      return { text: T.greetGeneral(es, name, link, { firstTurn }), intent: "greet", meta: { route: "deterministic", context_patch: { last_intent: "greet" } } };
  if (intent === "courtesy_greet") return { text: T.courtesy(es, name, link, { firstTurn }), intent: "courtesy_greet", meta: { route: "deterministic", context_patch: { last_intent: "courtesy_greet" } } };
  if (intent === "who")        return { text: T.who(es, name, link, { firstTurn }), intent: "who", meta: { route: "deterministic", context_patch: { last_intent: "who" } } };
  if (intent === "price")      return { text: T.price(es, link, { firstTurn }), intent: "price", meta: { route: "deterministic", context_patch: { last_intent: "price" } } };
  if (intent === "covered")    return { text: T.covered(es, link, { firstTurn }), intent: "covered", meta: { route: "deterministic", context_patch: { last_intent: "covered" } } };
  if (intent === "brushoff")   return { text: T.brushoff(es, link, { firstTurn }), intent: "brushoff", meta: { route: "deterministic", context_patch: { last_intent: "brushoff" } } };
  if (intent === "spouse")     return { text: T.spouse(es, link, { firstTurn }), intent: "spouse", meta: { route: "deterministic", context_patch: { last_intent: "spouse" } } };
  if (intent === "callme")     return { text: T.greetGeneral(es, name, link, { firstTurn }), intent: "callme", meta: { route: "deterministic", context_patch: { last_intent: "callme" } } };
  if (intent === "agree")      return { text: T.agree(es, link, { firstTurn }), intent: "agree", meta: { route: "deterministic", context_patch: { last_intent: "agree" } } };
  if (intent === "info")       return { text: T.info(es, link, { firstTurn }), intent: "info", meta: { route: "deterministic", context_patch: { last_intent: "info" } } };
  if (intent === "cant_talk")  return { text: T.cant_talk(es, link, { firstTurn }), intent: "cant_talk", meta: { route: "deterministic", context_patch: { last_intent: "cant_talk" } } };
  if (intent === "how_long")   return { text: T.how_long(es, link, { firstTurn }), intent: "how_long", meta: { route: "deterministic", context_patch: { last_intent: "how_long" } } };
  if (intent === "verify")     return { text: T.verify(es, name, link, { firstTurn }), intent: "verify", meta: { route: "deterministic", context_patch: { last_intent: "verify" } } };

  // fallback
  return {
    text: T.greetGeneral(es, name, link, { firstTurn }),
    intent: "greet",
    meta: { route: "fallback", context_patch: { last_intent: "greet" } }
  };
}

/* ---------------- decide ---------------- */
async function decide({
  text,
  agentName,
  agentSite,   // new: direct agent website
  agentPhone,  // new: available if we want to weave into future copy
  agentEmail,  // new: available if we want to weave into future copy
  tz,
  officeHours,
  context,
  useLLM,
  useLLMReply,
  llmMinConf,
} = {}) {
  tz = tz || DEFAULT_TZ;
  const es = detectSpanish(text);
  const name = agentName || (es ? "su corredor autorizado" : "your licensed broker");
  const link = (agentSite || "").trim(); // prefer agent site (brand-safe)

  // 1) Deterministic first
  const intentDet = classify(text);

  if (intentDet === "stop") {
    return { text: "", intent: "stop", meta: { route: "deterministic", context_patch: { last_intent: "stop" } }, action: "opt_out" };
  }

  let best = planNext({ intent: intentDet, text, es, link, name, context, tz });

  // 2) Optional: LLM classification override
  const wantLLM = typeof useLLM === "boolean" ? useLLM : LLM_ENABLED;
  const minConf = typeof llmMinConf === "number" ? llmMinConf : LLM_MIN_CONF;

  if (wantLLM) {
    try {
      const cls = await llmClassify(text);
      if (cls && Number(cls.confidence || 0) >= minConf) {
        const detFromLLM = planNext({
          intent: cls.intent || intentDet,
          text,
          es: /es/i.test(cls.lang || "") || es,
          link,
          name,
          context,
          tz,
        });
        best = {
          ...detFromLLM,
          meta: { ...(detFromLLM.meta || {}), llm_cls_conf: cls.confidence, llm_intent: cls.intent }
        };
      }
    } catch {}
  }

  // 3) Optional: LLM short-generation if fallback/generic
  const wantLLMReply = typeof useLLMReply === "boolean" ? useLLMReply : LLM_REPLY_ENABLED;
  const looksGeneric = best.meta?.route === "fallback" || best.intent === "general";
  const eligibleForGen =
    wantLLMReply &&
    best.intent !== "stop" &&
    best.intent !== "wrong" &&
    best.intent !== "confirm_time" &&
    best.intent !== "clarify_time";

  if (eligibleForGen && looksGeneric && typeof llmReply === "function") {
    try {
      const gen = await llmReply({
        text,
        language: es ? "es" : "en",
        calendlyLink: link,
        agentName: name,
        agentPhone: agentPhone || "",
        agentEmail: agentEmail || "",
        context: context || {},
        maxTokens: LLM_REPLY_MAXTOKENS
      });
      if (safe(gen.text)) {
        return {
          text: gen.text,
          intent: best.intent,
          meta: {
            ...(best.meta || {}),
            route: "llm_reply",
            llm_gen_conf: gen.confidence || null,
            llm_gen_reasons: gen.reasons || []
          }
        };
      }
    } catch {}
  }

  return best;
}

module.exports = { decide };
