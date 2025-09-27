// File: netlify/functions/ai-dispatch.js
// Purpose: Receive minimal context from telnyx-inbound and send a single AI-style reply
// using your existing messages-send function. Logs are noisy on purpose for debugging.

const { getServiceClient } = require("./_supabase");
const fetch = require("node-fetch");

/* ---------------- HTTP helpers ---------------- */
function json(body, statusCode = 200) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

/* ---------------- Utilities ---------------- */
function baseFromEvent(ev) {
  try {
    const proto =
      ev.headers?.["x-forwarded-proto"] ||
      ev.headers?.["X-Forwarded-Proto"] ||
      "https";
    const host =
      ev.headers?.host ||
      ev.headers?.Host ||
      process.env.URL ||
      process.env.DEPLOY_PRIME_URL ||
      "";
    return host ? `${proto}://${host}` : null;
  } catch {
    return null;
  }
}

function deriveMessagesSendUrl(event) {
  // You can hardcode with OUTBOUND_SEND_URL=https://your-domain (no trailing slash)
  const base =
    process.env.OUTBOUND_SEND_URL ||
    process.env.SITE_URL ||
    baseFromEvent(event);
  if (!base) return null;
  return `${String(base).replace(/\/$/, "")}/.netlify/functions/messages-send`;
}

/* ---------------- Minimal “AI” helpers ---------------- */
function detectSpanish(text) {
  const t = String(text || "").toLowerCase();
  if (/[ñáéíóú¿¡]/.test(t)) return true;
  const hits = [
    "cuánto","precio","costo","seguro","vida",
    "mañana","tarde","quién","numero","equivocado",
    "esposo","esposa","hola"
  ];
  let score = 0; hits.forEach(w => { if (t.includes(w)) score++; });
  return score >= 2;
}

function classifyIntent(txt) {
  const t = String(txt || "").trim().toLowerCase();
  if (!t) return "general";
  if (/\b(stop|unsubscribe|quit)\b/.test(t)) return "stop";             // handled in inbound already
  if (/\b(hi|hello|hola|hey)\b/.test(t)) return "greeting";
  if (/\b(price|how much|cost|monthly|cu[aá]nto|precio|costo)\b/.test(t)) return "price";
  if (/\b(who is this|who dis|qui[eé]n|how did you get|c[oó]mo obtuvo)\b/.test(t)) return "who";
  if (/\b(already have|covered|ya tengo|tengo seguro)\b/.test(t)) return "covered";
  if (/\b(not interested|no me interesa|busy|ocupad[oa])\b/.test(t)) return "brushoff";
  if (/\b(wrong number|n[uú]mero equivocado)\b/.test(t)) return "wrong";
  if (/\b(spouse|wife|husband|espos[ao])\b/.test(t)) return "spouse";
  if (/\b(call me|ll[aá]mame|ll[aá]mame)\b/.test(t)) return "callme";
  if (/\b(tom|tomorrow|ma[ñn]ana|today|hoy|evening|afternoon|morning)\b/.test(t)) return "time_window";
  if (/\b(1?\d\s*(?::\d{2})?\s*(am|pm))\b/.test(t)) return "time_specific"; // "10" alone won't match — intentional
  if (/^(ok|okay|sounds good|vale|bien|si|sí)\b/.test(t)) return "agree";
  return "general";
}

/** Synthesize three next-day slots within 09:00–21:00 local */
function synthesizeThreeSlots(agentTZ) {
  const tz = agentTZ || "America/Chicago";
  const next = new Date(); next.setDate(next.getDate() + 1);

  function mk(h, m = 0) {
    const d = new Date(next);
    d.setHours(h, m, 0, 0);
    return d;
  }
  const picks = [mk(9), mk(13), mk(18)].map((d) => ({
    label: d.toLocaleTimeString("en-US", {
      hour: "numeric", minute: "2-digit", hour12: true, timeZone: tz
    }),
    hours: d.getHours(),
    iso: d.toISOString(),
  }));

  const clamped = picks.filter(p => p.hours >= 9 && p.hours <= 21);
  const dayName = next.toLocaleDateString("en-US", { weekday: "long", timeZone: tz });
  return { dayName, slots: clamped };
}

/* ---------------- Agent profile ---------------- */
async function getAgentProfile(db, user_id) {
  const { data, error } = await db
    .from("agent_profiles")
    .select("full_name, calendly_url, email, phone")
    .eq("user_id", user_id)
    .maybeSingle();
  if (error) throw error;
  return data || {};
}

/* ---------------- Copy templates ---------------- */
function t_offer(dayName, slots) {
  const labels = slots.map(s => s.label);
  if (labels.length === 3) return `tomorrow (${dayName}) at ${labels[0]}, ${labels[1]}, or ${labels[2]}`;
  return `tomorrow at ${labels.join(", ")}`;
}
function t_greeting(isEs, agentName, offer) {
  return isEs
    ? `Hola—soy ${agentName}. Podemos revisar sus opciones en pocos minutos. ¿Le funciona ${offer}?`
    : `Hey there—it’s ${agentName}. We can go over your options in just a few minutes—would ${offer} work?`;
}
function t_price(isEs, offer) {
  return isEs
    ? `Buena pregunta—el precio depende de su edad, salud y la cantidad de cobertura. Solo toma unos minutos en una llamada para ver opciones exactas. Tengo ${offer}. ¿Cuál prefiere?`
    : `Great question—price depends on your age, health, and coverage amount. It only takes a few minutes on a quick call to see exact options. I have ${offer}. Which works best for you?`;
}
function t_covered(isEs, offer) {
  return isEs
    ? `Excelente. Aun así, muchas familias hacen una revisión rápida para no pagar de más ni perder beneficios. Tengo ${offer}. ¿Cuál le conviene?`
    : `Good to hear—you’re ahead of most folks. Many families still do a quick review to make sure they’re not overpaying or missing benefits. I have ${offer}. Which works better for you?`;
}
function t_who(isEs, agentName, offer) {
  return isEs
    ? `Hola, soy ${agentName}. Usted pidió información de seguro de vida y soy el corredor autorizado que da seguimiento. ¿Le funciona ${offer}?`
    : `Hey, it’s ${agentName}. You requested life insurance info recently where you listed your beneficiary, and I’m the licensed broker assigned to follow up. Would ${offer} work?`;
}
function t_brushoff(isEs, offer) {
  return isEs
    ? `Entiendo. Aun así, suele ser útil revisar opciones; toma solo unos minutos. Tengo ${offer}. ¿Cuál prefiere?`
    : `Totally understand—let’s keep it simple. It just takes a few minutes. I can do ${offer}. Which works better?`;
}
function t_callme(isEs) {
  return isEs
    ? `Claro—¿qué hora le conviene más? Puedo por la mañana o por la tarde.`
    : `Absolutely—what time works best for you? I can do mornings or afternoons.`;
}
function t_spouse(isEs, offer) {
  return isEs
    ? `Perfecto—programemos cuando puedan estar ambos. Tengo ${offer}. ¿Cuál funciona mejor para ustedes?`
    : `Makes sense—let’s set a quick time when you can both be on. I have ${offer}. Which works best for you two?`;
}
function t_wrong(isEs) {
  return isEs
    ? `¡Disculpe la molestia! Ya que estamos—¿tiene su seguro de vida al día?`
    : `My apologies! Since I’ve got you—have you already got your life insurance taken care of?`;
}
function t_agree(isEs, offer) {
  return isEs
    ? `Perfecto—reserve unos minutos. Tengo ${offer}. ¿Cuál prefiere?`
    : `Great—let’s set aside a few minutes. I have ${offer}. Which works best for you?`;
}
function t_confirm(isEs, tsLabel) {
  return isEs
    ? `Perfecto, le llamo mañana a las ${tsLabel}. Lo mantenemos en unos minutos.`
    : `Perfect, I’ll call you tomorrow at ${tsLabel}. We’ll keep it to just a few minutes.`;
}
function t_link(isEs, link) {
  return isEs
    ? `Aquí tiene un enlace para confirmar y recibir recordatorios (y reprogramar si hace falta): ${link}`
    : `Here’s a quick link to confirm so you’ll get reminders (and can reschedule if needed): ${link}`;
}

/* ---------------- Main handler ---------------- */
exports.handler = async (event) => {
  const db = getServiceClient();

  // Body must be: { user_id, contact_id, from, to, text }
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}
  const { user_id, contact_id, from, to, text } = body || {};

  console.log("[ai-dispatch] start", { user_id, contact_id, from, to, text });

  if (!user_id || !contact_id || !from || !to || !text) {
    console.warn("[ai-dispatch] missing required fields");
    return json({ ok: false, error: "missing_fields" }, 400);
  }

  // Respect unsubscribed / booked here as well (defensive)
  try {
    const { data: contactRow } = await db
      .from("message_contacts")
      .select("id, subscribed, ai_booked")
      .eq("id", contact_id)
      .maybeSingle();
    if (contactRow?.subscribed === false) {
      console.log("[ai-dispatch] contact unsubscribed; silent");
      return json({ ok: true, skipped: "unsubscribed" });
    }
    if (contactRow?.ai_booked === true) {
      console.log("[ai-dispatch] already booked; silent");
      return json({ ok: true, skipped: "booked" });
    }
  } catch {}

  // Classify & build reply
  const isEs = detectSpanish(text);
  const intent = classifyIntent(text);
  const agent = await getAgentProfile(db, user_id);
  const calendlyLink = agent?.calendly_url || "";
  const { dayName, slots } = synthesizeThreeSlots(process.env.AGENT_DEFAULT_TZ || "America/Chicago");
  const offerText = t_offer(dayName, slots);

  let bodyText;
  let aiIntentTag;

  if (intent === "time_specific") {
    const m = text.match(/(1?\d\s*(?::\d{2})?\s*(am|pm))/i);
    const tsLabel = m ? m[1].toUpperCase().replace(/\s+/g, " ") : slots[1]?.label || "the time we discussed";
    bodyText = t_confirm(isEs, tsLabel);
    aiIntentTag = "confirm_time";
  } else {
    switch (intent) {
      case "greeting":
        bodyText = t_greeting(isEs, agent?.full_name || "your licensed broker", offerText);
        aiIntentTag = "greeting"; break;
      case "price":
        bodyText = t_price(isEs, offerText);
        aiIntentTag = "price"; break;
      case "who":
        bodyText = t_who(isEs, agent?.full_name || "your licensed broker", offerText);
        aiIntentTag = "who"; break;
      case "covered":
        bodyText = t_covered(isEs, offerText);
        aiIntentTag = "covered"; break;
      case "brushoff":
        bodyText = t_brushoff(isEs, offerText);
        aiIntentTag = "brushoff"; break;
      case "callme":
        bodyText = t_callme(isEs);
        aiIntentTag = "callme"; break;
      case "spouse":
        bodyText = t_spouse(isEs, offerText);
        aiIntentTag = "spouse"; break;
      case "wrong":
        bodyText = t_wrong(isEs);
        aiIntentTag = "wrong"; break;
      case "time_window":
      case "agree":
      case "general":
      default:
        bodyText = t_agree(isEs, offerText);
        aiIntentTag = "offer_slots"; break;
    }
  }

  // Send via messages-send
  const sendUrl = deriveMessagesSendUrl(event);
  console.log("[ai-dispatch] messages-send URL:", sendUrl);

  if (!sendUrl) {
    console.error("[ai-dispatch] no messages-send URL derived");
    return json({ ok: false, error: "no_messages_send_url" }, 500);
  }

  let sendOut = {};
  try {
    const resp = await fetch(sendUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: from,           // reply back to the lead
        body: bodyText,
        requesterId: user_id,
      }),
    });
    sendOut = await resp.json().catch(() => ({}));
    console.log("[ai-dispatch] messages-send response:", resp.status, sendOut);
    if (!resp.ok || sendOut?.error) {
      throw new Error(sendOut?.error || `send_status_${resp.status}`);
    }
  } catch (e) {
    console.error("[ai-dispatch] send failed:", e?.message || e);
    return json({ ok: false, error: "send_failed" }, 502);
  }

  // Tag the new message row so your UI shows the tiny "AI" badge
  try {
    if (sendOut?.id) {
      await getServiceClient()
        .from("messages")
        .update({ meta: { sent_by_ai: true, ai_intent: aiIntentTag } })
        .eq("id", sendOut.id);
    }
  } catch (e) {
    console.warn("[ai-dispatch] tagging meta failed (non-fatal):", e?.message || e);
  }

  // If specific time, mark booked to keep AI silent after booking
  if (intent === "time_specific") {
    try {
      await getServiceClient().from("message_contacts").update({ ai_booked: true }).eq("id", contact_id);
      if (calendlyLink) {
        // send a follow-up with the link
        const resp2 = await fetch(sendUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            to: from,
            body: (isEs
              ? `Aquí tiene un enlace para confirmar y recibir recordatorios (y reprogramar si hace falta): ${calendlyLink}`
              : `Here’s a quick link to confirm so you’ll get reminders (and can reschedule if needed): ${calendlyLink}`),
            requesterId: user_id,
          }),
        });
        console.log("[ai-dispatch] link follow-up status:", resp2.status);
      }
    } catch (e) {
      console.warn("[ai-dispatch] booked/link step non-fatal error:", e?.message || e);
    }
  }

  return json({ ok: true, id: sendOut?.id || null, intent: aiIntentTag });
};