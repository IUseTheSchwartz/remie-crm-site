// File: netlify/functions/ai-dispatch.js
// Receives { user_id, contact_id, from, to, text } from telnyx-inbound.
// Classifies the text and sends one reply through messages-send.
// Adds meta.sent_by_ai=true so the UI shows the AI badge.

const { getServiceClient } = require("./_supabase");
const fetch = require("node-fetch");

/* ---------------- HTTP helpers ---------------- */
function ok(body) {
  return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || { ok: true }) };
}
function bad(msg, code = 400) {
  return { statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: false, error: msg }) };
}

/* ---------------- Classifiers & helpers ---------------- */
function detectSpanish(text) {
  const t = String(text || "").toLowerCase();
  if (/[ñáéíóú¿¡]/.test(t)) return true;
  const hits = ["cuánto","precio","costo","seguro","vida","mañana","tarde","quién","numero","equivocado","esposo","esposa"];
  let score = 0; hits.forEach((w)=>{ if (t.includes(w)) score += 1; });
  return score >= 2;
}
function classifyIntent(txt) {
  const t = String(txt || "").trim().toLowerCase();
  if (!t) return "general";
  if (/\b(stop|unsubscribe|quit)\b/.test(t)) return "stop";
  if (/\b(call me|ll[aá]mame)\b/.test(t)) return "callme";
  if (/\b(price|how much|cost|monthly|cu[aá]nto|precio|costo)\b/.test(t)) return "price";
  if (/\b(who is this|who dis|qui[eé]n|how did you get|c[oó]mo obtuvo)\b/.test(t)) return "who";
  if (/\b(already have|covered|ya tengo|tengo seguro)\b/.test(t)) return "covered";
  if (/\b(not interested|no me interesa|busy|ocupad[oa])\b/.test(t)) return "brushoff";
  if (/\b(wrong number|n[uú]mero equivocado)\b/.test(t)) return "wrong";
  if (/\b(spouse|wife|husband|espos[ao])\b/.test(t)) return "spouse";
  if (/\b(hi|hello|hola|hey)\b/.test(t)) return "greeting";
  if (/\b(tom|tomorrow|ma[ñn]ana|today|hoy|evening|afternoon|morning)\b/.test(t)) return "time_window";
  if (/\b(1?\d\s*(?::\d{2})?\s*(am|pm))\b/.test(t)) return "time_specific";
  if (/^(ok|okay|sounds good|vale|bien|si|sí)\b/.test(t)) return "agree";
  return "general";
}

/** Next-day three options within 09:00–21:00 local. */
function synthesizeThreeSlots(agentTZ) {
  const tz = agentTZ || "America/Chicago";
  const next = new Date(); next.setDate(next.getDate() + 1);

  function mk(h, m = 0) { const d = new Date(next); d.setHours(h, m, 0, 0); return d; }
  const picks = [mk(9,0), mk(13,0), mk(18,0)].map((d) => ({
    label: d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: tz }),
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

/* ---------------- Templates ---------------- */
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
    ? `Excelente. Aun así, muchas familias hacen una revisión rápida para no pagar de más ni perder beneficios. Toma solo unos minutos. Tengo ${offer}. ¿Cuál le conviene?`
    : `Good to hear—you’re ahead of most folks. Many families still do a quick review to make sure they’re not overpaying or missing benefits. I have ${offer}. Which works better for you?`;
}
function t_who(isEs, agentName, offer) {
  return isEs
    ? `Hola, soy ${agentName}. Usted solicitó información sobre seguros de vida y soy el corredor autorizado asignado para ayudarle. ¿Le funciona ${offer}?`
    : `Hey, it’s ${agentName}. You requested info about life insurance recently where you listed your beneficiary, and I’m the licensed broker assigned to follow up. Would ${offer} work?`;
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

/* ---------------- URL helper ---------------- */
function deriveSendUrl(event) {
  const env = process.env.OUTBOUND_SEND_URL || process.env.SITE_URL || process.env.URL || process.env.DEPLOY_PRIME_URL;
  if (env) return String(env).endsWith("/messages-send") ? env : `${String(env).replace(/\/$/, "")}/.netlify/functions/messages-send`;
  const proto = (event.headers && (event.headers["x-forwarded-proto"] || event.headers["X-Forwarded-Proto"])) || "https";
  const host  = (event.headers && (event.headers.host || event.headers.Host)) || "";
  return host ? `${proto}://${host}/.netlify/functions/messages-send` : null;
}

/* ---------------- Handler ---------------- */
exports.handler = async (event) => {
  const db = getServiceClient();

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}
  const { user_id, contact_id, from, to, text } = body || {};

  console.log("[ai-dispatch] payload:", { user_id, contact_id, from, to, text });
  if (!user_id || !contact_id || !from || !to) {
    console.error("[ai-dispatch] missing fields");
    return bad("missing_fields", 400);
  }

  // If contact unsubscribed or already booked, stay silent
  try {
    const { data: contact } = await db.from("message_contacts")
      .select("id, subscribed, ai_booked").eq("id", contact_id).maybeSingle();
    if (contact?.subscribed === false) return ok({ ok: true, note: "contact_unsubscribed" });
    if (contact?.ai_booked === true)  return ok({ ok: true, note: "ai_silent_booked" });
  } catch {}

  const isEs  = detectSpanish(text);
  const intent = classifyIntent(text);
  const agent  = await getAgentProfile(db, user_id);
  const calendlyLink = agent?.calendly_url || "";

  const { dayName, slots } = synthesizeThreeSlots(process.env.AGENT_DEFAULT_TZ || "America/Chicago");
  const offerText = t_offer(dayName, slots);

  const sendUrl = deriveSendUrl(event);
  console.log("[ai-dispatch] OUTBOUND_SEND_URL:", sendUrl);

  async function send(bodyText, meta) {
    if (!sendUrl) {
      console.error("[ai-dispatch] no OUTBOUND_SEND_URL; skipping send");
      return { ok: false, skipped: true };
    }
    const res = await fetch(sendUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: from, body: bodyText, requesterId: user_id }),
    });
    const out = await res.json().catch(() => ({}));
    console.log("[ai-dispatch] messages-send status:", res.status, out);

    if (!res.ok || out?.error) return { ok: false, error: out?.error || `status_${res.status}` };

    // Tag the message so UI shows AI badge
    try {
      if (out?.id) await db.from("messages").update({ meta: { sent_by_ai: true, ...(meta || {}) } }).eq("id", out.id);
    } catch {}
    return { ok: true, id: out?.id };
  }

  // Specific time like "10am" → confirm + link → mark booked
  if (intent === "time_specific") {
    const m = text.match(/(1?\d\s*(?::\d{2})?\s*(am|pm))/i);
    const tsLabel = m ? m[1].toUpperCase().replace(/\s+/g, " ") : slots[1]?.label || "the time we discussed";
    await send(t_confirm(isEs, tsLabel), { ai_intent: "confirm_time" });
    if (calendlyLink) await send(t_link(isEs, calendlyLink), { ai_intent: "link" });
    try { await db.from("message_contacts").update({ ai_booked: true }).eq("id", contact_id); } catch {}
    return ok({ ok: true, ai: "confirmed_and_linked" });
  }

  // Default routing
  switch (intent) {
    case "greeting":
      await send(t_greeting(isEs, agent?.full_name || "your licensed broker", offerText), { ai_intent: "greeting" });
      break;
    case "price":
      await send(t_price(isEs, offerText), { ai_intent: "price" });
      break;
    case "who":
      await send(t_who(isEs, agent?.full_name || "your licensed broker", offerText), { ai_intent: "who" });
      break;
    case "covered":
      await send(t_covered(isEs, offerText), { ai_intent: "covered" });
      break;
    case "brushoff":
      await send(t_brushoff(isEs, offerText), { ai_intent: "brushoff" });
      break;
    case "callme":
      await send(t_callme(isEs), { ai_intent: "callme" });
      break;
    case "spouse":
      await send(t_spouse(isEs, offerText), { ai_intent: "spouse" });
      break;
    case "wrong":
      await send(t_wrong(isEs), { ai_intent: "wrong" });
      break;
    case "time_window":
    case "agree":
    case "general":
    default:
      await send(t_agree(isEs, offerText), { ai_intent: "offer_slots" });
      break;
  }

  return ok({ ok: true, ai: "responded" });
};