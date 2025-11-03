// File: netlify/functions/ai-dispatch.js
// Thin dispatcher: parse -> guard -> load agent -> delegate to AI brain -> send one reply.
// Now: when AI confirms a time, we create a CRM appointment for the contact.

const { getServiceClient } = require("./_supabase");
const fetch = require("node-fetch");
const { AbortController } = require("abort-controller");
const { decide } = require("./ai-brain"); // pure logic module

/* ---------------- HTTP helpers ---------------- */
function ok(body) {
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || { ok: true }),
  };
}
function bad(msg, code = 400, extra = {}) {
  return {
    statusCode: code,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ok: false, error: msg, ...extra }),
  };
}

/* ---------------- Parsing helpers ---------------- */
const isJSON = (h) => String(h || "").toLowerCase().includes("application/json");
const isForm = (h) => String(h || "").toLowerCase().includes("application/x-www-form-urlencoded");

/* ---------------- URL helpers ---------------- */
function deriveSendUrl(event) {
  const env =
    process.env.OUTBOUND_SEND_URL ||
    process.env.SITE_URL ||
    process.env.URL ||
    process.env.DEPLOY_PRIME_URL;

  if (env)
    return String(env).endsWith("/messages-send")
      ? env
      : `${String(env).replace(/\/$/, "")}/.netlify/functions/messages-send`;

  const proto =
    (event.headers &&
      (event.headers["x-forwarded-proto"] || event.headers["X-Forwarded-Proto"])) || "https";
  const host = (event.headers && (event.headers.host || event.headers.Host)) || "";
  return host ? `${proto}://${host}/.netlify/functions/messages-send` : null;
}

function agentSiteOrigin() {
  return (process.env.PUBLIC_SITE_ORIGIN || "https://remiecrm.com").replace(/\/$/, "");
}

/* ---------------- Data helpers ---------------- */
async function getAgentProfile(db, user_id) {
  const { data, error } = await db
    .from("agent_profiles")
    .select("full_name, calendly_url, email, phone, slug")
    .eq("user_id", user_id)
    .maybeSingle();
  if (error) throw error;
  return data || {};
}

function buildAgentBookingLink(agent) {
  const slug = (agent?.slug || "").trim();
  if (slug && /^[a-z0-9-]+$/i.test(slug)) return `${agentSiteOrigin()}/a/${slug}`;
  if (agent?.calendly_url) return agent.calendly_url;
  return "";
}

/* ---------------- Time parsing (label -> next datetime in tz) ---------------- */
function getNowPartsInTZ(tz) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}
function toUTCFromTZ({ year, month, day, hour, minute }, tz) {
  // Build a local string in tz and let Date parse it with that TZ using toLocaleString trick.
  // Safer path: we compute the instant by asking what the UTC time is when the wall clock in tz shows Y-M-D H:M.
  const asLocal = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  // Offset between UTC "now" and "now in tz"
  const now = new Date();
  const nowInTZ = new Date(now.toLocaleString("en-US", { timeZone: tz }));
  const offsetMs = nowInTZ.getTime() - now.getTime();
  // Apply the same offset to our target "local" time to approximate wall time in tz back to UTC
  return new Date(asLocal.getTime() - offsetMs);
}
function parseClockLabelToNext(label, tz = "America/Chicago") {
  const s = String(label || "").trim().toUpperCase();
  if (s === "NOON") return parseClockLabelToNext("12:00 PM", tz);

  const m = s.match(/\b(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\b/);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2] || "0");
  const ampm = m[3];

  if (hour === 12) hour = (ampm === "AM") ? 0 : 12; // 12AM -> 0, 12PM -> 12
  else if (ampm === "PM") hour += 12;

  const nowParts = getNowPartsInTZ(tz);
  let target = toUTCFromTZ({ ...nowParts, hour, minute }, tz);

  // If it's already passed in that TZ today, schedule tomorrow
  const nowInTZ = new Date(new Date().toLocaleString("en-US", { timeZone: tz }));
  const targetInTZ = new Date(target.toLocaleString("en-US", { timeZone: tz }));
  if (targetInTZ.getTime() <= nowInTZ.getTime()) {
    // add 1 day in tz terms
    const tomorrow = new Date(targetInTZ.getTime() + 24 * 60 * 60 * 1000);
    const y = tomorrow.getFullYear();
    const mo = tomorrow.getMonth() + 1;
    const d = tomorrow.getDate();
    target = toUTCFromTZ({ year: y, month: mo, day: d, hour, minute }, tz);
  }
  return target.toISOString();
}

/* ---------------- Handler ---------------- */
exports.handler = async (event) => {
  const db = getServiceClient();

  // Decode body (supports base64)
  let raw = event.body || "";
  if (event.isBase64Encoded) {
    try { raw = Buffer.from(raw, "base64").toString("utf8"); } catch {}
  }

  // Parse body robustly
  const headers = event.headers || {};
  const ct = headers["content-type"] || headers["Content-Type"] || "";
  let body = {};
  try {
    if (isJSON(ct)) body = raw ? JSON.parse(raw) : {};
    else if (isForm(ct)) body = Object.fromEntries(new URLSearchParams(raw));
    else { try { body = JSON.parse(raw); } catch { body = Object.fromEntries(new URLSearchParams(raw)); } }
  } catch (e) {
    console.warn("[ai-dispatch] parse error", e?.message);
  }

  const { user_id, contact_id, from, to, text } = body || {};

  console.log("[ai-dispatch] payload:", {
    user_id, contact_id, from, to,
    text: text ? `(len=${text.length})` : undefined,
  });
  if (!user_id || !contact_id || !from || !to) {
    console.error("[ai-dispatch] missing fields", { ct, sample: raw?.slice?.(0, 160) });
    return bad("missing_fields", 400);
  }

  // Respect contact state (unsubscribe / booked silence is managed upstream)
  try {
    const { data: contact } = await db
      .from("message_contacts")
      .select("id, subscribed, ai_booked, full_name, ai_language, meta")
      .eq("id", contact_id)
      .maybeSingle();
    if (contact?.subscribed === false) return ok({ ok: true, note: "contact_unsubscribed" });
  } catch (e) {
    console.warn("[ai-dispatch] contact lookup warn:", e?.message || e);
  }

  // Load agent profile and compute brand-safe booking link
  const agent = await getAgentProfile(db, user_id).catch(() => ({}));
  const agentName = agent?.full_name || "your licensed broker";
  const bookingLink = buildAgentBookingLink(agent);
  const tz = process.env.AGENT_DEFAULT_TZ || "America/Chicago";

  // --------- SAFETY NET: price/quotes/estimates guard ----------
  const norm = String(text || "").toLowerCase();
  const priceHint = /\b(price|how much|cost|monthly|payment|premium|quotes?|estimate|estimates?|rate|rates?)\b/.test(norm);
  if (priceHint) {
    const es = /[ñáéíóúü¿¡]/.test(norm) || /(precio|costo|prima|cotizaci[oó]n|cotizaciones)/.test(norm);
    const outText = es
      ? `Perfecto—las cifras dependen de edad/salud y del beneficiario. Es una llamada breve de 5–7 min.${bookingLink ? ` Puede elegir horario aquí: ${bookingLink}` : ""} ¿Qué hora le queda mejor?`
      : `Totally—exact numbers depend on age/health and beneficiary. It’s a quick 5–7 min call.${bookingLink ? ` You can grab a time here: ${bookingLink}` : ""} What time works for you?`;

    const sendUrl = deriveSendUrl(event);
    console.log("[ai-dispatch] price-guard matched; sending deterministic price reply via:", sendUrl);
    if (!sendUrl) return ok({ ok: false, error: "no_outbound_url", ai_intent: "price", via: "price-guard" });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    let res, json = {};
    try {
      res = await fetch(sendUrl, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: from, body: outText, requesterId: user_id, sent_by_ai: true, ai_intent: "price" }),
        signal: controller.signal,
      });
      try { json = await res.json(); } catch {}
      console.log("[ai-dispatch] messages-send (price-guard) status:", res.status, json);
    } catch (e) {
      console.error("[ai-dispatch] messages-send error (price-guard):", e?.name || e?.message || String(e));
    } finally { clearTimeout(timeout); }

    return ok({ ok: true, ai: "responded", ai_intent: "price", via: "price-guard", send_status: json?.error ? "error" : "ok", send_json: json });
  }
  // ------------------------------------------------------------

  // Delegate to brain
  let decision = { text: "", intent: "general" };
  try {
    decision = (await decide({
      text, agentName, calendlyLink: bookingLink, tz,
      // context: {} // (future conv state)
    })) || decision;
  } catch (e) {
    console.error("[ai-dispatch] brain error:", e?.message || e);
    return ok({ ok: true, note: "brain_error_no_send" });
  }

  const outText = String(decision?.text || "").trim();
  const aiIntent = decision?.intent || "general";

  console.log("[ai-dispatch] brain:", {
    normalized: norm,
    intent: aiIntent,
    route: decision?.meta?.route,
    conf: decision?.meta?.conf || decision?.meta?.llm_cls_conf || null,
    preview: outText.slice(0, 120),
  });

  if (!outText) return ok({ ok: true, note: "no_text_from_brain", ai_intent: aiIntent });

  // If the AI confirmed a specific time, try to create a CRM appointment before sending
  let createdAppointmentId = null;
  let scheduledAtISO = null;
  if (aiIntent === "confirm_time") {
    const label =
      (decision?.meta?.label) ||
      (decision?.meta?.time_label) ||
      (outText.match(/at\s+([0-9]{1,2}(?::[0-9]{2})?\s?(?:AM|PM))/i)?.[1]) ||
      null;

    const iso = label ? parseClockLabelToNext(label, tz) : null;
    scheduledAtISO = iso;

    try {
      const { data, error } = await db
        .from("crm_appointments")
        .insert([{
          user_id,
          contact_id,
          title: "Discovery Call",
          // Store the text label too for reference
          time_label: label || null,
          scheduled_at: iso,
          source: "sms_ai",
        }])
        .select("id")
        .maybeSingle();
      if (error) throw error;
      createdAppointmentId = data?.id || null;

      // mark contact as booked for your UI
      try {
        await db.from("message_contacts").update({ ai_booked: true }).eq("id", contact_id);
      } catch {}
    } catch (e) {
      console.warn("[ai-dispatch] create appointment warn:", e?.message || e);
    }
  }

  // Send via messages-send
  const sendUrl = deriveSendUrl(event);
  console.log("[ai-dispatch] OUTBOUND_SEND_URL:", sendUrl);
  if (!sendUrl) return ok({ ok: false, error: "no_outbound_url", ai_intent: aiIntent });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);

  let res, json = {};
  try {
    res = await fetch(sendUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: from,
        body: outText,
        requesterId: user_id,
        sent_by_ai: true,
        ai_intent: aiIntent,
      }),
      signal: controller.signal,
    });
    try { json = await res.json(); } catch {}
    console.log("[ai-dispatch] messages-send status:", res.status, json);
  } catch (e) {
    console.error("[ai-dispatch] messages-send error:", e?.name || e?.message || String(e));
  } finally {
    clearTimeout(timeout);
  }

  if (!res || !res.ok || json?.error) {
    return ok({ ok: false, error: json?.error || `status_${res?.status}`, ai_intent: aiIntent });
  }

  return ok({
    ok: true,
    ai: "responded",
    ai_intent: aiIntent,
    appointment_id: createdAppointmentId,
    scheduled_at: scheduledAtISO,
  });
};
