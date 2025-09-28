// Thin dispatcher: parse -> guard -> load agent -> delegate to AI brain -> send one reply.
// All language/intent logic lives in ./ai-brain.js (exports decide()).

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
  // Allow override for previews; default to production origin.
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
  if (slug && /^[a-z0-9-]+$/i.test(slug)) {
    return `${agentSiteOrigin()}/a/${slug}`;
  }
  // Fallbacks (optional): if you want to *never* send Calendly, return "" here.
  // We’ll keep Calendly as *secondary* fallback only if present.
  if (agent?.calendly_url) return agent.calendly_url;
  return "";
}

/* ---------------- Handler ---------------- */
exports.handler = async (event) => {
  const db = getServiceClient();

  // Decode body (supports base64)
  let raw = event.body || "";
  if (event.isBase64Encoded) {
    try {
      raw = Buffer.from(raw, "base64").toString("utf8");
    } catch {}
  }

  // Parse body robustly
  const headers = event.headers || {};
  const ct = headers["content-type"] || headers["Content-Type"] || "";
  let body = {};
  try {
    if (isJSON(ct)) {
      body = raw ? JSON.parse(raw) : {};
    } else if (isForm(ct)) {
      body = Object.fromEntries(new URLSearchParams(raw));
    } else {
      try {
        body = JSON.parse(raw);
      } catch {
        body = Object.fromEntries(new URLSearchParams(raw));
      }
    }
  } catch (e) {
    console.warn("[ai-dispatch] parse error", e?.message);
  }

  const { user_id, contact_id, from, to, text } = body || {};

  console.log("[ai-dispatch] payload:", {
    user_id,
    contact_id,
    from,
    to,
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
      .select("id, subscribed, ai_booked, full_name")
      .eq("id", contact_id)
      .maybeSingle();
    if (contact?.subscribed === false) {
      return ok({ ok: true, note: "contact_unsubscribed" });
    }
    // If you still want to silence booked, uncomment:
    // if (contact?.ai_booked === true) return ok({ ok: true, note: "ai_silent_booked" });
  } catch (e) {
    console.warn("[ai-dispatch] contact lookup warn:", e?.message || e);
  }

  // Load agent profile and compute brand-safe booking link
  const agent = await getAgentProfile(db, user_id).catch(() => ({}));
  const agentName = agent?.full_name || "your licensed broker";
  const bookingLink = buildAgentBookingLink(agent); // <-- brand-safe link (agent site)
  const tz = process.env.AGENT_DEFAULT_TZ || "America/Chicago";

  // Delegate to brain
  let decision = { text: "", intent: "general" };
  try {
    decision =
      (await decide({
        text,
        agentName,
        calendlyLink: bookingLink, // we pass the agent-site link here
        tz,
        // context: { firstTurn: false }, // set true when you use it for first outbound
      })) || decision;
  } catch (e) {
    console.error("[ai-dispatch] brain error:", e?.message || e);
    return ok({ ok: true, note: "brain_error_no_send" });
  }

  const outText = String(decision?.text || "").trim();
  const aiIntent = decision?.intent || "general";

  console.log("[ai-dispatch] brain:", {
    intent: aiIntent,
    route: decision?.meta?.route,
    conf: decision?.meta?.conf,
    preview: outText.slice(0, 120),
  });

  if (!outText) {
    return ok({ ok: true, note: "no_text_from_brain", ai_intent: aiIntent });
  }

  // Send via messages-send
  const sendUrl = deriveSendUrl(event);
  console.log("[ai-dispatch] OUTBOUND_SEND_URL:", sendUrl);

  if (!sendUrl) {
    console.error("[ai-dispatch] no OUTBOUND_SEND_URL; skipping send");
    return ok({ ok: false, error: "no_outbound_url", ai_intent: aiIntent });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);

  let res,
    json = {};
  try {
    res = await fetch(sendUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: from, body: outText, requesterId: user_id }),
      signal: controller.signal,
    });
    try {
      json = await res.json();
    } catch {}
    console.log("[ai-dispatch] messages-send status:", res.status, json);
  } catch (e) {
    console.error("[ai-dispatch] messages-send error:", e?.name || e?.message || String(e));
  } finally {
    clearTimeout(timeout);
  }

  if (!res || !res.ok || json?.error) {
    return ok({ ok: false, error: json?.error || `status_${res?.status}`, ai_intent: aiIntent });
  }

  // Tag sent message for UI (boolean column + meta JSON)
  try {
    if (json?.id) {
      // 1) Try to update explicit boolean/intent columns if they exist
      const { error: colErr } = await db
        .from("messages")
        .update({ sent_by_ai: true, ai_intent: aiIntent })
        .eq("id", json.id);

      if (colErr) {
        console.warn("[ai-dispatch] sent_by_ai column update failed (ok if column missing):", colErr.message);
      }

      // 2) Merge into meta JSON (backward-compat)
      const { data: msg, error: selErr } = await db
        .from("messages")
        .select("meta")
        .eq("id", json.id)
        .maybeSingle();

      if (!selErr) {
        const mergedMeta = { ...(msg?.meta || {}), sent_by_ai: true, ai_intent: aiIntent };
        await db.from("messages").update({ meta: mergedMeta }).eq("id", json.id);
      }
    }
  } catch (e) {
    console.warn("[ai-dispatch] tag AI message warn:", e?.message || e);
  }

  // Mark booked on confirm
  if (aiIntent === "confirm_time") {
    try {
      await db.from("message_contacts").update({ ai_booked: true }).eq("id", contact_id);
    } catch {}
  }

  return ok({ ok: true, ai: "responded", ai_intent: aiIntent });
};
