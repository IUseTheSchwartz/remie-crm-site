// Pure response logic: language, intent, slots (9am–9pm), copy.

function detectSpanish(t = "") {
  t = t.toLowerCase();
  return /[ñáéíóú¿¡]/.test(t) || /(cu[aá]nto|precio|costo|seguro|vida|mañana|qu[ié]n)/.test(t);
}

function classify(t = "") {
  t = t.trim().toLowerCase();
  if (!t) return "general";
  if (/\b(stop|unsubscribe|quit)\b/.test(t)) return "stop";
  if (/\b(price|how much|cost|monthly|cu[aá]nto|precio|costo)\b/.test(t)) return "price";
  if (/\b(who is this|who dis|qu[ié]n)\b/.test(t)) return "who";
  if (/\b(already have|covered|ya tengo|tengo seguro)\b/.test(t)) return "covered";
  if (/\b(not interested|busy|ocupad[oa])\b/.test(t)) return "brushoff";
  if (/\b(wrong number|n[uú]mero equivocado)\b/.test(t)) return "wrong";
  if (/\b(spouse|wife|husband|espos[ao])\b/.test(t)) return "spouse";
  if (/\b(\b1?\d\b\s*(?::\d{2})?\s*(am|pm))\b/.test(t)) return "time_specific";
  if (/^(hi|hey|hello|hola|who\??|who’s this\??|who is this\??)/.test(t)) return "greet";
  return "general";
}

function nextDaySlots(tz = "America/Chicago", window = { start: 9, end: 21 }) {
  const base = new Date();
  base.setDate(base.getDate() + 1);
  const picks = [10.5, 14, 18]; // 10:30a, 2:00p, 6:00p
  const slots = picks
    .map((h) => {
      const d = new Date(base);
      const hours = Math.min(Math.max(Math.floor(h), window.start), window.end);
      const minutes = h % 1 ? 30 : 0;
      d.setHours(hours, minutes, 0, 0);
      return {
        label: d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: tz }),
        iso: d.toISOString(),
        h: hours,
      };
    })
    .filter((s) => s.h >= window.start && s.h <= window.end);
  const dayName = base.toLocaleDateString("en-US", { weekday: "long", timeZone: tz });
  return { dayName, slots };
}

function offerTxt(dayName, slots) {
  const [a, b, c] = slots.map((s) => s.label);
  return `tomorrow (${dayName}) at ${a}, ${b}, or ${c}`;
}

function decide({ text, agentName, calendlyLink, tz, officeHours }) {
  const isEs = detectSpanish(text);
  const intent = classify(text);
  const { dayName, slots } = nextDaySlots(tz, officeHours);
  const offer = offerTxt(dayName, slots);

  const T = {
    greet: isEs
      ? (n) => `Hola—soy ${n}. ¿Le funciona ${offer}?`
      : (n) => `Hey there—it’s ${n}. Would ${offer} work?`,
    who: isEs
      ? (n) => `Hola, soy ${n}. Usted solicitó información de seguro de vida. Podemos verlo en unos minutos—¿le funciona ${offer}?`
      : (n) => `Hey, it’s ${n}. You requested info about life insurance recently where you listed your beneficiary. We can go over options in just a few minutes—would ${offer} work?`,
    price: isEs
      ? () => `Buena pregunta—el precio depende de edad, salud y cobertura. Lo vemos en una llamada corta. Tengo ${offer}. ¿Cuál prefiere?`
      : () => `Good question—price depends on age, health, and coverage. We’ll nail it on a quick call. I have ${offer}. Which works best?`,
    covered: isEs
      ? () => `Excelente. Aun así, muchas familias hacen una revisión rápida para no pagar de más ni perder beneficios. Toma pocos minutos. Tengo ${offer}. ¿Cuál le conviene?`
      : () => `That’s great—you’re ahead of most folks. Many still do a quick review to avoid overpaying or missing benefits. I have ${offer}. Which works best?`,
    brushoff: isEs
      ? () => `Entiendo. Normalmente una revisión corta ayuda; toma pocos minutos. Tengo ${offer}. ¿Cuál prefiere?`
      : () => `Totally understand—most people feel that way until they see how fast it is. Let’s set aside a few minutes. I have ${offer}. Which works best?`,
    spouse: isEs
      ? () => `Perfecto—mejor con ambos. Programemos. Tengo ${offer}. ¿Cuál funciona mejor para ustedes?`
      : () => `Totally—best to do it together. Let’s set a quick time when you can both be on. I have ${offer}. Which works better?`,
    wrong: isEs
      ? () => `¡Disculpe la molestia! Ya que estamos—¿tiene su seguro de vida al día?`
      : () => `My apologies! Since I’ve got you—do you already have your life insurance taken care of?`,
    general: isEs
      ? () => `Perfecto—agendemos unos minutos. Tengo ${offer}. ¿Cuál prefiere?`
      : () => `Great—let’s set aside a few minutes. I have ${offer}. Which works best for you?`,
  };

  if (intent === "time_specific") {
    const m = String(text).match(/(\b1?\d\b\s*(?::\d{2})?\s*(am|pm))/i);
    const tsLabel = m ? m[1].toUpperCase().replace(/\s+/g, " ") : slots[1].label;
    const confirm = isEs
      ? `Perfecto, le llamo mañana a las ${tsLabel}. Lo mantenemos en unos minutos.`
      : `Perfect—I’ll call you tomorrow at ${tsLabel}. We’ll keep it to just a few minutes.`;
    const link = calendlyLink
      ? (isEs
          ? ` Aquí tiene un enlace para confirmar y recibir recordatorios (y reprogramar si hace falta): ${calendlyLink}`
          : ` Here’s a quick link to confirm so you’ll get reminders (and can reschedule if needed): ${calendlyLink}`)
      : "";
    return { text: `${confirm}${link}`, intent: "confirm_time" };
  }

  if (intent === "greet")   return { text: T.greet(agentName),   intent };
  if (intent === "who")     return { text: T.who(agentName),     intent };
  if (intent === "price")   return { text: T.price(),            intent };
  if (intent === "covered") return { text: T.covered(),          intent };
  if (intent === "brushoff")return { text: T.brushoff(),         intent };
  if (intent === "spouse")  return { text: T.spouse(),           intent };
  if (intent === "wrong")   return { text: T.wrong(),            intent };
  return { text: T.general(), intent: "general" };
}

module.exports = { decide };