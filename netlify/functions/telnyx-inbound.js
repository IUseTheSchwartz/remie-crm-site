// File: netlify/functions/telnyx-inbound.js
// Inserts incoming SMS, handles STOP/START, pauses Lead Rescue,
// and (NEW) drives natural AI replies for appointment setting.

const { getServiceClient } = require("./_supabase");
const fetch = require("node-fetch"); // ensure fetch exists in function runtime

function ok(body) {
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || { ok: true }),
  };
}

const norm10 = (s) => String(s || "").replace(/\D/g, "").slice(-10);
function toE164(p) {
  const d = String(p || "").replace(/\D/g, "");
  if (!d) return null;
  if (d.startsWith("1") && d.length === 11) return `+${d}`;
  if (d.length === 10) return `+1${d}`;
  if (String(p).startsWith("+")) return String(p);
  return null;
}

/* ===== Deterministic To→agent mapping (your existing behavior + direct TFN ownership) ===== */
async function resolveUserId(db, telnyxToE164) {
  // A) Direct ownership via per-agent TFN
  const { data: owner } = await db
    .from("agent_messaging_numbers")
    .select("user_id")
    .eq("e164", telnyxToE164)
    .maybeSingle();
  if (owner?.user_id) return owner.user_id;

  // B) Most recent outgoing message that used this number as "from"
  const { data: m } = await db
    .from("messages")
    .select("user_id")
    .eq("from_number", telnyxToE164)
    .order("created_at", { ascending: false })
    .limit(1);
  if (m && m[0]?.user_id) return m[0].user_id;

  // C) Shared number fallback (optional)
  const SHARED =
    process.env.TELNYX_FROM ||
    process.env.TELNYX_FROM_NUMBER ||
    process.env.DEFAULT_FROM_NUMBER ||
    null;
  if (SHARED && SHARED === telnyxToE164) {
    // Custom shared-number behavior could go here if you want it later.
  }

  // D) Final fallback
  return process.env.INBOUND_FALLBACK_USER_ID || process.env.DEFAULT_USER_ID || null;
}

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

function parseKeyword(textIn) {
  const raw = String(textIn || "").trim();
  const normalized = raw.toUpperCase().replace(/[^A-Z]/g, ""); // letters only
  const STOP_SET = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);
  const START_SET = new Set(["START", "YES", "UNSTOP"]);

  // Optional: treat "NO" as STOP (toggle via env)
  const treatNo = String(process.env.INBOUND_TREAT_NO_AS_STOP || "true").toLowerCase() === "true";
  if (treatNo && normalized === "NO") return "STOP";

  if (STOP_SET.has(normalized)) return "STOP";
  if (START_SET.has(normalized)) return "START";
  return null;
}

// STRICT: mark Lead Rescue as responded + paused
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

/* ===================== AI helpers ===================== */

function classifyIntent(txt) {
  const t = String(txt || "").trim().toLowerCase();
  if (!t) return "general";

  // fast exits / common branches
  if (/\b(who is this|who dis|who’s this|quien eres|quién eres)\b/.test(t)) return "who";
  if (/\b(price|how much|cost|quote|rate|monthly|precio|cuánto|costo)\b/.test(t)) return "price";
  if (/\b(call me|ll[aá]mame|llamame|can you call)\b/.test(t)) return "callme";
  if (/\b(already have|covered|i'm covered|ya tengo|tengo seguro)\b/.test(t)) return "covered";
  if (/\b(not interested|no me interesa|busy|ocupad[oa])\b/.test(t)) return "brushoff";
  if (/\b(wrong number|n[úu]mero equivocado)\b/.test(t)) return "wrong";
  if (/\b(spouse|wife|husband|espos[ao])\b/.test(t)) return "spouse";

  // time windows / specifics
  if (/\b(tomorrow|today|tonight|mañana|hoy|tarde|noche|evening|afternoon|morning)\b/.test(t)) return "time_window";
  if (/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/.test(t)) return "time_specific";

  // greeting / agreement
  if (/^(hi|hey|hello|hola|buenas)\b/.test(t)) return "greeting";
  if (/^(ok|okay|sounds good|vale|bien|si|sí)\b/.test(t)) return "agree";

  return "general";
}

const TZ_FALLBACK = process.env.AGENT_DEFAULT_TZ || "America/Chicago";
const WORK_START = 9;  // 09:00
const WORK_END = 21;   // 21:00 (9 PM)

// Simple local-time helper without external deps (assumes server in UTC)
function toLocalDate(tz, d = new Date()) {
  // Create a new Date that represents "now" in that TZ by using the parts formatter.
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit"
  }).formatToParts(d).reduce((acc, p) => (acc[p.type] = p.value, acc), {});
  const iso = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`;
  return new Date(iso);
}

function formatHuman(dt, tz) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "long",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  return fmt.format(dt);
}

function formatHumanNoWeekday(dt, tz) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  return fmt.format(dt);
}

function nextDayLocalMidnight(tz) {
  const now = toLocalDate(tz);
  const d = new Date(now);
  d.setDate(now.getDate() + 1);
  d.setHours(0, 0, 0, 0);
  return d;
}

function clampToWindow(dt, startHour = WORK_START, endHour = WORK_END) {
  const d = new Date(dt);
  const h = d.getHours();
  if (h < startHour) d.setHours(startHour, 0, 0, 0);
  if (h > endHour) d.setHours(endHour, 0, 0, 0);
  return d;
}

function synthesizeThreeSlots(tz) {
  const base = nextDayLocalMidnight(tz);
  const slots = [9, 13, 18]; // 9:00 AM, 1:00 PM, 6:00 PM
  return slots.map((h) => {
    const d = new Date(base);
    d.setHours(h, 0, 0, 0);
    return d;
  });
}

function parseTimeFromText(tz, txt) {
  const t = String(txt || "").toLowerCase();
  const isTomorrow = /\b(tom|tomorrow|mañana)\b/.test(t);
  const baseDay = isTomorrow ? nextDayLocalMidnight(tz) : toLocalDate(tz);

  // hh(:mm)? am/pm
  const m = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  if (m) {
    let hh = parseInt(m[1], 10);
    const mm = m[2] ? parseInt(m[2], 10) : 0;
    const ap = m[3];
    if (ap === "pm" && hh !== 12) hh += 12;
    if (ap === "am" && hh === 12) hh = 0;
    const d = new Date(baseDay);
    d.setHours(hh, mm, 0, 0);
    return clampToWindow(d);
  }
  // “noon” / “midday”
  if (/\b(noon|midday)\b/.test(t)) {
    const d = new Date(baseDay);
    d.setHours(12, 0, 0, 0);
    return clampToWindow(d);
  }
  // “evening / afternoon / morning”
  if (/\bmorning\b/.test(t)) {
    const d = new Date(baseDay); d.setHours(10, 0, 0, 0); return clampToWindow(d);
  }
  if (/\bafternoon\b/.test(t)) {
    const d = new Date(baseDay); d.setHours(14, 0, 0, 0); return clampToWindow(d);
  }
  if (/\bevening\b/.test(t) || /\btonight\b/.test(t)) {
    const d = new Date(baseDay); d.setHours(18, 0, 0, 0); return clampToWindow(d);
  }
  return null;
}

function withinWindow(dt, startHr = WORK_START, endHr = WORK_END) {
  const h = dt.getHours();
  return h >= startHr && h <= endHr;
}

async function getAgentProfile(db, user_id) {
  const { data, error } = await db
    .from("agent_profiles")
    .select("full_name, calendly_url")
    .eq("user_id", user_id)
    .maybeSingle();
  if (error) throw error;
  return data || {};
}

function warmGreeting(agentName, dayName, slotStrs, includeIntroOnly = false) {
  const intro = `Hey there — it’s ${agentName}.`;
  if (includeIntroOnly) return `${intro} How can I help today?`;
  return `${intro} We can go over your options in just a few minutes. Would tomorrow (${dayName}) at ${slotStrs[0]}, ${slotStrs[1]}, or ${slotStrs[2]} work?`;
}

function pricePivot(agentName, dayName, slotStrs) {
  return `Great question — the exact price depends on a couple of quick details like age and coverage. The fastest way is to go over it together on a brief call. I have tomorrow (${dayName}) at ${slotStrs[0]}, ${slotStrs[1]}, or ${slotStrs[2]}. Which works best for you?`;
}

async function sendAIText({ to, user_id, body }) {
  const SITE_URL = process.env.SITE_URL || "";
  const OUTBOUND_SEND_URL =
    process.env.OUTBOUND_SEND_URL ||
    (SITE_URL ? `${SITE_URL.replace(/\/$/, "")}/.netlify/functions/messages-send` : null);

  if (!OUTBOUND_SEND_URL) {
    // No sender configured—just no-op OK
    return { ok: false, error: "outbound_send_url_missing" };
  }

  const res = await fetch(OUTBOUND_SEND_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      to,
      body,
      requesterId: user_id,
      // If your messages-send supports it, this flag will store and render the AI badge.
      sent_by_ai: true,
    }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok || out?.error) {
    return { ok: false, error: out?.error || out?.detail || "send_failed", raw: out };
  }
  return { ok: true, data: out };
}

/* ===================== Handler ===================== */

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

  // Ensure a contact exists
  const contact = await findOrCreateContact(db, user_id, from);

  // Insert the inbound message row
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

  // Any inbound reply stops Lead Rescue
  await stopLeadRescueOnReply(db, user_id, contact.id);

  // STOP/START keywords (hard stop / resume)
  const action = parseKeyword(text);
  if (action === "STOP") {
    await db.from("message_contacts").update({ subscribed: false }).eq("id", contact.id);
    return ok({ ok: true, action: "unsubscribed" });
  }
  if (action === "START") {
    await db.from("message_contacts").update({ subscribed: true }).eq("id", contact.id);
    return ok({ ok: true, action: "resubscribed" });
  }

  // Respect subscription & booked state
  if (contact?.subscribed === false) return ok({ ok: true, note: "skipped_unsubscribed" });
  if (contact?.ai_booked) return ok({ ok: true, note: "skipped_already_booked" });

  // ====== AI Response Flow ======
  try {
    const agent = await getAgentProfile(db, user_id);
    const agentName = agent?.full_name || "your licensed broker";
    const tz = TZ_FALLBACK; // (Optional: store per-agent tz later)

    const tomorrow = nextDayLocalMidnight(tz);
    const dayName = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" }).format(tomorrow);

    // Offer only 9a–9p
    const slots = synthesizeThreeSlots(tz);
    const slotStrs = slots.map((d) => formatHumanNoWeekday(d, tz));

    const calendly = agent?.calendly_url || "";

    const intent = classifyIntent(text);

    let reply = null;

    if (intent === "greeting") {
      reply = warmGreeting(agentName, dayName, slotStrs, false);
    } else if (intent === "who") {
      reply = `Hey! It’s ${agentName}. You requested info about life insurance recently where you listed your beneficiary, and I’m the licensed broker assigned to follow up. We can go over your options in just a few minutes—would tomorrow (${dayName}) at ${slotStrs[0]}, ${slotStrs[1]}, or ${slotStrs[2]} work?`;
    } else if (intent === "price") {
      reply = pricePivot(agentName, dayName, slotStrs);
    } else if (intent === "time_specific" || intent === "time_window" || intent === "callme" || intent === "agree") {
      const when = parseTimeFromText(tz, text);
      if (when && withinWindow(when)) {
        const human = formatHuman(when, tz);
        if (calendly) {
          reply = `Yes, I can make ${human} work. I’ll give you a quick call then. Here’s a quick link to confirm so it’s locked in: ${calendly}`;
        } else {
          reply = `Yes, I can make ${human} work. I’ll give you a quick call then.`;
        }
        // Stop the AI after confirmation text
        try {
          await db.from("message_contacts").update({ ai_booked: true }).eq("id", contact.id);
        } catch {}
      } else {
        // Out-of-hours or ambiguous → offer three options within window
        reply = `I usually take calls between 9:00 AM and 9:00 PM. Would tomorrow (${dayName}) at ${slotStrs[0]}, ${slotStrs[1]}, or ${slotStrs[2]} work?`;
      }
    } else if (intent === "covered") {
      reply = `Got it—totally respect that. If anything changes or you want a quick review to make sure your current coverage still fits, I’m happy to help. Otherwise, have a great day!`;
    } else if (intent === "wrong") {
      reply = `Sorry about that! I’ll make sure you’re removed. If you know who might have requested info, feel free to let me know.`;
    } else if (intent === "brushoff") {
      reply = `No problem. I can text you a quick link so you can pick a time later, or we can circle back another day. What works best for you?`;
    } else if (intent === "spouse") {
      reply = `Totally fine—we can include your spouse. A quick few minutes is all we need. Would tomorrow (${dayName}) at ${slotStrs[0]}, ${slotStrs[1]}, or ${slotStrs[2]} work?`;
    } else {
      // General fallback = natural intro + three in-window options
      reply = warmGreeting(agentName, dayName, slotStrs, false);
    }

    if (!reply) return ok({ ok: true, note: "no_reply_built" });

    const send = await sendAIText({ to: from, user_id, body: reply });
    if (!send.ok) {
      return ok({ ok: false, error: "ai_send_failed", detail: send.error || send.raw || null });
    }

    return ok({ ok: true, ai_sent: true });
  } catch (e) {
    // swallow AI failure (so inbound webhook always 200s)
    return ok({ ok: true, ai_error: String(e?.message || e) });
  }
};