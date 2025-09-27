// File: netlify/functions/telnyx-inbound.js
// Inserts incoming SMS and handles STOP/START opt-out/opt-in.
// Adds AI-like auto-reply: warm-up + 3 next-day slots (9a–9p); confirm + Calendly link; stop after booking.

const { getServiceClient } = require("./_supabase");
const fetch = require("node-fetch");

/* ---------------- HTTP helpers ---------------- */
function ok(body) {
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || { ok: true }),
  };
}

/* ---------------- Phone helpers ---------------- */
const norm10 = (s) => String(s || "").replace(/\D/g, "").slice(-10);
function toE164(p) {
  const d = String(p || "").replace(/\D/g, "");
  if (!d) return null;
  if (d.startsWith("1") && d.length === 11) return `+${d}`;
  if (d.length === 10) return `+1${d}`;
  if (String(p).startsWith("+")) return String(p);
  return null;
}

/* ---------------- Agent resolution ---------------- */
async function resolveUserId(db, telnyxToE164) {
  // A) direct match in per-agent number table
  const { data: owner } = await db
    .from("agent_messaging_numbers")
    .select("user_id")
    .eq("e164", telnyxToE164)
    .maybeSingle();
  if (owner?.user_id) return owner.user_id;

  // B) most recent outgoing using this number
  const { data: m } = await db
    .from("messages")
    .select("user_id")
    .eq("from_number", telnyxToE164)
    .order("created_at", { ascending: false })
    .limit(1);
  if (m && m[0]?.user_id) return m[0].user_id;

  // C) shared number optional behavior
  const SHARED =
    process.env.TELNYX_FROM ||
    process.env.TELNYX_FROM_NUMBER ||
    process.env.DEFAULT_FROM_NUMBER ||
    null;
  if (SHARED && SHARED === telnyxToE164) {
    // no-op; keep default fallback
  }

  // D) final fallback
  return process.env.INBOUND_FALLBACK_USER_ID || process.env.DEFAULT_USER_ID || null;
}

/* ---------------- Contacts ---------------- */
async function findOrCreateContact(db, user_id, fromE164) {
  const last10 = norm10(fromE164);
  const { data, error } = await db
    .from("message_contacts")
    .select("id, phone, subscribed, ai_booked, full_name")
    .eq("user_id", user_id);
  if (error) throw error;

  const found = (data || []).find((c) => norm10(c.phone) === last10);
  if (found) return found;

  const ins = await db
    .from("message_contacts")
    .insert([{ user_id, phone: fromE164, subscribed: true, ai_booked: false }])
    .select("id, phone, subscribed, ai_booked, full_name")
    .maybeSingle();
  if (ins.error) throw ins.error;
  return ins.data;
}

/* ---------------- STOP/START ---------------- */
function parseKeyword(textIn) {
  const raw = String(textIn || "").trim();
  const normalized = raw.toUpperCase().replace(/[^A-Z]/g, "");
  const STOP_SET = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);
  const START_SET = new Set(["START", "YES", "UNSTOP"]);

  const treatNo = String(process.env.INBOUND_TREAT_NO_AS_STOP || "true").toLowerCase() === "true";
  if (treatNo && normalized === "NO") return "STOP";
  if (STOP_SET.has(normalized)) return "STOP";
  if (START_SET.has(normalized)) return "START";
  return null;
}

/* ---------------- Lead Rescue integration ---------------- */
async function stopLeadRescueOnReply(db, user_id, contact_id) {
  const now = new Date().toISOString();
  const { error } = await db
    .from("lead_rescue_trackers")
    .update({
      responded: true,
      paused: true,
      stop_reason: "responded",
      last_reply_at: now,
      responded_at: now,
    })
    .eq("user_id", user_id)
    .eq("contact_id", contact_id);
  if (error) throw error;
}

/* ---------------- URL derivation (fix: no SITE_URL needed) ---------------- */
function deriveOutboundUrl(event) {
  const envUrl = process.env.OUTBOUND_SEND_URL || process.env.SITE_URL;
  if (envUrl) {
    const base = String(envUrl).replace(/\/$/, "");
    return `${base}/.netlify/functions/messages-send`;
  }
  try {
    const proto =
      (event.headers && (event.headers["x-forwarded-proto"] || event.headers["X-Forwarded-Proto"])) ||
      "https";
    const host =
      (event.headers && (event.headers.host || event.headers.Host)) ||
      process.env.URL ||
      process.env.DEPLOY_PRIME_URL ||
      "";
    if (host) return `${proto}://${host}/.netlify/functions/messages-send`;
  } catch {}
  return null;
}

/* ---------------- Minimal "AI" helpers (rule-based) ---------------- */
function detectSpanish(text) {
  const t = String(text || "").toLowerCase();
  if (/[ñáéíóú¿¡]/.test(t)) return true;
  const hits = ["cuánto", "precio", "costo", "seguro", "vida", "mañana", "tarde", "quién", "numero", "equivocado", "esposo", "esposa"];
  let score = 0;
  hits.forEach((w) => { if (t.includes(w)) score += 1; });
  return score >= 2;
}

function classifyIntent(txt) {
  const t = String(txt || "").trim().toLowerCase();
  if (!t) return "general";
  if (/\b(stop|unsubscribe|quit)\b/.test(t)) return "stop";
  if (/\b(call me|ll[aá]mame|ll[aá]mame)\b/.test(t)) return "callme";
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

/** Next-day three options within 09:00–21:00 local (default: 9:00, 1:00, 6:00). */
function synthesizeThreeSlots(agentTZ) {
  const tz = agentTZ || "America/Chicago";
  const next = new Date();
  next.setDate(next.getDate() + 1);

  function mk(h, m = 0) {
    const d = new Date(next);
    d.setHours(h, m, 0, 0);
    return d;
  }

  const picks = [mk(9, 0), mk(13, 0), mk(18, 0)].map((d) => ({
    label: d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: tz }),
    hours: d.getHours(),
    iso: d.toISOString(),
  }));

  // extra guard: clamp to 9–21 if someone tweaks defaults later
  const clamped = picks.filter((p) => p.hours >= 9 && p.hours <= 21);
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

/* ---------------- Send via your messages-send function ---------------- */
async function sendAI(db, { user_id, toE164, body, meta, sendUrl }) {
  if (!sendUrl) {
    console.warn("[ai] missing outbound url; inserting system note instead");
    await db.from("messages").insert([{
      user_id, direction: "outgoing", provider: "system",
      from_number: "system", to_number: toE164,
      body: `[AI not sent: missing OUTBOUND_SEND_URL] ${body}`,
      status: "skipped", price_cents: 0, meta: { ...(meta || {}), sent_by_ai: true }
    }]);
    return { ok: false, skipped: true, reason: "no_outbound_url" };
  }

  const res = await fetch(sendUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      to: toE164,
      body,
      requesterId: user_id,
      // messages-send doesn't accept meta; we'll tag after insert below.
    }),
  });

  const out = await res.json().catch(() => ({}));
  if (!res.ok || out?.error) {
    console.error("[ai] send failed", res.status, out?.error);
    await db.from("messages").insert([{
      user_id, direction: "outgoing", provider: "system",
      from_number: "system", to_number: toE164,
      body: `[AI send failed] ${body}`,
      status: "error", price_cents: 0, meta: { ...(meta || {}), sent_by_ai: true }
    }]);
    return { ok: false, error: out?.error || `status_${res.status}` };
  }

  // Tag the just-created row so UI can show "AI" badge.
  try {
    if (out?.id) {
      await db.from("messages").update({ meta: { sent_by_ai: true, ...(meta || {}) } }).eq("id", out.id);
    }
  } catch {}

  return { ok: true, id: out?.id };
}

/* ---------------- Templates (EN & ES) ---------------- */
function t_offer(dayName, slots) {
  const labels = slots.map((s) => s.label);
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
    ? `Buena pregunta—el precio depende de su edad, salud y la cantidad de cobertura. Solo toma unos minutos en una llamada para ver sus opciones exactas. Tengo ${offer}. ¿Cuál prefiere?`
    : `Great question—price depends on your age, health, and coverage amount. It takes just a few minutes on a quick call to see exact options. I have ${offer}. Which works best for you?`;
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

/* ---------------- Handler ---------------- */
exports.handler = async (event) => {
  const db = getServiceClient();

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}

  const data = body.data || body;
  const payload = data.payload || data;

  const providerSid = payload?.id || data?.id || null;
  const from = toE164(payload?.from?.phone_number || payload?.from || "");
  const to   = toE164((Array.isArray(payload?.to) && payload.to[0]?.phone_number) || payload?.to || "");
  const text = String(payload?.text || payload?.body || "").trim();

  if (!providerSid || !from || !to) {
    return ok({ ok: true, note: "missing_fields" });
  }

  // Dedupe on provider+sid
  const { data: dupe } = await db
    .from("messages")
    .select("id")
    .eq("provider", "telnyx")
    .eq("provider_sid", providerSid)
    .limit(1);
  if (dupe && dupe.length) return ok({ ok: true, deduped: true });

  const user_id = await resolveUserId(db, to);
  if (!user_id) return ok({ ok: false, error: "no_user_for_number", to });

  // Ensure contact
  const contact = await findOrCreateContact(db, user_id, from);

  // Insert inbound message row
  const row = {
    user_id,
    contact_id: contact?.id || null,
    direction: "incoming",
    provider: "telnyx",
    from_number: from,
    to_number: to,
    body: text,
    status: "received",
    provider_sid: providerSid,
    price_cents: 0,
  };
  const ins = await db.from("messages").insert([row]);
  if (ins.error) return ok({ ok: false, error: ins.error.message });

  // Pause Lead Rescue on any reply
  try { await stopLeadRescueOnReply(db, user_id, contact.id); } catch {}

  // STOP/START keywords
  const action = parseKeyword(text);
  if (action === "STOP") {
    await db.from("message_contacts").update({ subscribed: false }).eq("id", contact.id);
    return ok({ ok: true, action: "unsubscribed" });
  }
  if (action === "START") {
    await db.from("message_contacts").update({ subscribed: true }).eq("id", contact.id);
    return ok({ ok: true, action: "resubscribed" });
  }

  // Respect unsubscribed / already booked
  if (contact.subscribed === false) return ok({ ok: true, note: "contact_unsubscribed" });
  if (contact.ai_booked === true)  return ok({ ok: true, note: "ai_silent_booked" });

  // "AI" decisioning
  const isEs = detectSpanish(text);
  const intent = classifyIntent(text);

  // Agent context & offer
  const agent = await getAgentProfile(db, user_id);
  const calendlyLink = agent?.calendly_url || "";
  const { dayName, slots } = synthesizeThreeSlots(process.env.AGENT_DEFAULT_TZ || "America/Chicago");
  const offerText = t_offer(dayName, slots);

  // Build outbound URL once
  const outboundUrl = deriveOutboundUrl(event);
  console.log("[ai] outbound url:", outboundUrl);

  // Helper: send and tag
  async function send(bodyText, meta) {
    return await sendAI(db, { user_id, toE164: from, body: bodyText, meta, sendUrl: outboundUrl });
  }

  // Specific time like "10am" → confirm + link → mark booked
  if (intent === "time_specific") {
    const m = text.match(/(1?\d\s*(?::\d{2})?\s*(am|pm))/i);
    const tsLabel = m ? m[1].toUpperCase().replace(/\s+/g, " ") : slots[1]?.label || "the time we discussed";
    await send(t_confirm(isEs, tsLabel), { ai_intent: "confirm_time" });
    if (calendlyLink) await send(t_link(isEs, calendlyLink), { ai_intent: "link" });
    await db.from("message_contacts").update({ ai_booked: true }).eq("id", contact.id);
    return ok({ ok: true, ai: "confirmed_and_linked" });
  }

  // Route by intent (always push to time)
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