// netlify/functions/ai-brain.js
function detectSpanish(t='') {
  t = t.toLowerCase();
  return /[ñáéíóú¿¡]/.test(t) || /(cu[aá]nto|precio|costo|seguro|vida|mañana|qu[ié]n)/.test(t);
}

function classify(t='') {
  t = t.trim().toLowerCase();
  if (!t) return 'general';
  if (/\b(stop|unsubscribe|quit)\b/.test(t)) return 'stop';
  if (/\b(price|how much|cost|monthly|cu[aá]nto|precio|costo)\b/.test(t)) return 'price';
  if (/\b(who is this|who dis|qu[ié]n)\b/.test(t)) return 'who';
  if (/\b(already have|covered|ya tengo|tengo seguro)\b/.test(t)) return 'covered';
  if (/\b(not interested|busy|ocupad[oa])\b/.test(t)) return 'brushoff';
  if (/\b(wrong number|n[uú]mero equivocado)\b/.test(t)) return 'wrong';
  if (/\b(spouse|wife|husband|espos[ao])\b/.test(t)) return 'spouse';
  if (/\b(\d{1,2}\s*(?:am|pm))\b/.test(t)) return 'time_specific';
  if (/^(hi|hey|hello|hola|who\??|who’s this\??|who is this\??)/.test(t)) return 'greet';
  return 'general';
}

function nextDaySlots(tz='America/Chicago', window={start:9,end:21}) {
  const base = new Date();
  base.setDate(base.getDate() + 1);
  const picks = [10, 14, 18]; // 10am, 2pm, 6pm
  const slots = picks
    .map(h => Math.min(Math.max(h, window.start), window.end))
    .map(h => {
      const d = new Date(base);
      d.setHours(h, (h===10?30:0), 0, 0); // 10:30am feels natural, others on the hour
      return {
        label: d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz }),
        iso: d.toISOString(),
      };
    });
  const dayName = base.toLocaleDateString('en-US', { weekday: 'long', timeZone: tz });
  return { dayName, slots };
}

function offerTxt(dayName, slots) {
  const [a,b,c] = slots.map(s => s.label);
  return `tomorrow (${dayName}) at ${a}, ${b}, or ${c}`;
}

function decide({ text, agentName, calendlyLink, tz, officeHours }) {
  const isEs = detectSpanish(text);
  const intent = classify(text);
  const { dayName, slots } = nextDaySlots(tz, officeHours);
  const offer = offerTxt(dayName, slots);

  const T = {
    greet: isEs
      ? (name) => `Hola—soy ${name}. ¿Le funciona ${offer}?`
      : (name) => `Hey there—it’s ${name}. Would ${offer} work?`,
    who: isEs
      ? (name) => `Hola, soy ${name}. Usted solicitó información de seguro de vida recientemente. Podemos verlo en unos minutos—¿le funciona ${offer}?`
      : (name) => `Hey, it’s ${name}. You requested info about life insurance recently where you listed your beneficiary. We can go over options in just a few minutes—would ${offer} work?`,
    price: isEs
      ? () => `Buena pregunta—el precio depende de edad, salud y cobertura. Lo vemos en una llamada corta. Tengo ${offer}. ¿Cuál prefiere?`
      : () => `Great question—price depends on age, health, and coverage. We can nail it on a quick call. I have ${offer}. Which works best?`,
    covered: isEs
      ? () => `Excelente. Aun así, muchas familias hacen una revisión rápida para no pagar de más ni perder beneficios. Solo toma unos minutos. Tengo ${offer}. ¿Cuál le conviene?`
      : () => `That’s great—you’re ahead of most folks. Many still do a quick review to avoid overpaying or missing benefits. I have ${offer}. Which works best?`,
    brushoff: isEs
      ? () => `Entiendo. Normalmente una revisión corta ayuda; toma pocos minutos. Tengo ${offer}. ¿Cuál prefiere?`
      : () => `Totally understand—most people feel that way until they see how quick it is. Let’s set aside a few minutes. I have ${offer}. Which works best?`,
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

  if (intent === 'time_specific') {
    const m = text.match(/(\d{1,2}\s*(?:am|pm))/i);
    const tsLabel = m ? m[1].toUpperCase() : slots[1].label;
    const confirm = isEs
      ? `Perfecto, le llamo mañana a las ${tsLabel}. Lo mantenemos en unos minutos.`
      : `Perfect—I’ll call you tomorrow at ${tsLabel}. We’ll keep it to just a few minutes.`;
    const link = calendlyLink
      ? (isEs
          ? `Aquí tiene un enlace rápido para confirmar y recibir recordatorios (y reprogramar si hace falta): ${calendlyLink}`
          : `Here’s a quick link to confirm so you’ll get reminders (and can reschedule if needed): ${calendlyLink}`)
      : '';
    return { text: link ? `${confirm} ${link}` : confirm, intent: 'confirm_time' };
  }

  if (intent === 'greet') return { text: T.greet(agentName), intent };
  if (intent === 'who')   return { text: T.who(agentName),   intent };
  if (intent === 'price') return { text: T.price(),          intent };
  if (intent === 'covered') return { text: T.covered(),      intent };
  if (intent === 'brushoff') return { text: T.brushoff(),    intent };
  if (intent === 'spouse') return { text: T.spouse(),        intent };
  if (intent === 'wrong')  return { text: T.wrong(),         intent };
  return { text: T.general(), intent: 'general' };
}

module.exports = { decide };
