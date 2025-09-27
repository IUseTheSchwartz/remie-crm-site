// File: netlify/functions/ai-dispatch.js
// Thin dispatcher: parse -> guard -> load agent -> delegate to AI brain -> send one reply.
// All language/intent/slot logic lives in ./ai-brain.js (exports decide()).

const { getServiceClient } = require("./_supabase");
const fetch = require("node-fetch");
const { AbortController } = require("abort-controller");
const { decide } = require("./ai-brain"); // <-- pure logic module

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

/* ---------------- Body parsing helpers ---------------- */
const isJSON = (h) => String(h || "").toLowerCase().includes("application/json");
const isForm = (h) => String(h || "").toLowerCase().includes("application/x-www-form-urlencoded");

/* ---------------- URL helper ---------------- */
function deriveSendUrl(event) {
  const env = process.env.OUTBOUND_SEND_URL || process.env.SITE_URL || process.env.URL || process.env.DEPLOY_PRIME_URL;
  if (env) return String(env).endsWith("/messages-send") ? env : `${String(env).replace(/\/$/, "")}/.netlify/functions/messages-send`;
  const proto = (event.headers && (event.headers["x-forwarded-proto"] || event.headers["X-Forwarded-Proto"])) || "https";
  const host  = (event.headers && (event.headers.host || event.headers.Host)) || "";
  return host ? `${proto}://${host}/.netlify/functions/messages-send` : null;
}

/* ---------------- Data helpers ---------------- */
async function getAgentProfile(db, user_id) {
  const { data, error } = await db
    .from("agent_profiles")
    .select("full_name, calendly_url, email, phone")
    .eq("user_id", user_id)
    .maybeSingle();
  if (error) throw error;
  return data || {};
}

/** Try to enrich context from your DB; all optional. */
async function buildContext(db, contact_id) {
  const ctx = { firstTurn: false };

  // A) Is this their first inbound? (There will already be at least 1 inbound row inserted by telnyx-inbound.)
  try {
    const { data: inbounds } = await db
      .from("messages")
      .select("id")
      .eq("contact_id", contact_id)
      .eq("direction", "incoming")
      .order("created_at", { ascending: true })
      .limit(2);
    if (Array.isArray(inbounds) && inbounds.length === 1) {
      ctx.firstTurn = true;
    }
  } catch {}

  // B) Optional: pull lead fields if you have a leads table (adjust to your schema).
  // Attempt common names; ignore if table/columns don’t exist.
  try {
    const { data: lead } = await db
      .from("leads") // <-- change to your table if different (e.g., "crm_leads")
      .select("first_name, state, beneficiary")
      .eq("contact_id", contact_id)
      .maybeSingle();
    if (lead) {
      if (lead.first_name) ctx.firstName = lead.first_name;
      if (lead.state) ctx.state = lead.state;
      if (lead.beneficiary) ctx.beneficiary = lead.beneficiary;
    }
  } catch {}

  return ctx;
}

/* ---------------- Handler ---------------- */
exports.handler = async (event) => {
  const db = getServiceClient();

  // ---- decode body (handles base64) ----
  let raw = event.body || "";
  if (event.isBase64Encoded) {
    try { raw = Buffer.from(raw, "base64").toString("utf8"); } catch {}
  }

  // ---- parse body robustly ----
  const headers = event.headers || {};
  const ct = headers["content-type"] || headers["Content-Type"] || "";
  let body = {};
  try {
    if (isJSON(ct)) {
      body = raw ? JSON.parse(raw) : {};
    } else if (isForm(ct)) {
      body = Object.fromEntries(new URLSearchParams(raw));
    } else {
      try { body = JSON.parse(raw); }
      catch { body = Object.fromEntries(new URLSearchParams(raw)); }
    }
  } catch (e) {
    console.warn("[ai-dispatch] parse error", e?.message);
  }

  const { user_id, contact_id, from, to, text } = body || {};

  console.log("[ai-dispatch] payload:", {
    user_id, contact_id, from, to, text: text ? `(len=${text.length})` : undefined,
  });
  if (!user_id || !contact_id || !from || !to) {
    console.error("[ai-dispatch] missing fields", { ct, sample: raw?.slice?.(0, 160) });
    return bad("missing_fields", 400);
  }

  // ---- respect contact state (unsubscribe / booked silence is managed by caller or policy)
  try {
    const { data: contact } = await db.from("message_contacts")
      .select("id, subscribed, ai_booked, full_name")
      .eq("id", contact_id)
      .maybeSingle();
    if (contact?.subscribed === false) {
      return ok({ ok: true, note: "contact_unsubscribed" });
    }
    // If you want to silence after booking, uncomment:
    // if (contact?.ai_booked === true) {
    //   return ok({ ok: true, note: "ai_silent_booked" });
    // }
  } catch (e) {
    console.warn("[ai-dispatch] contact lookup warn:", e?.message || e);
  }

  // ---- load agent profile
  const agent = await getAgentProfile(db, user_id).catch(() => ({}));
  const agentName = agent?.full_name || "your licensed broker";
  const calendlyLink = agent?.calendly_url || "";
  const tz = process.env.AGENT_DEFAULT_TZ || "America/Chicago";

  // ---- build lead/turn context (optional enrichment)
  const context = await buildContext(db, contact_id).catch(() => ({ firstTurn: false }));

  // ---- env flags for hybrid LLM fallback
  const useLLM = String(process.env.AI_BRAIN_USE_LLM || "true").toLowerCase() === "true";
  const llmMinConf = Number(process.env.AI_BRAIN_LLM_CONFIDENCE || 0.55);

  // ---- delegate to AI brain (pure logic)
  let decision = { text: "", intent: "general", meta: null };
  try {
    decision = await decide({
      text,
      agentName,
      calendlyLink,
      tz,
      // officeHours: { start: 9, end: 21 }, // optional override
      context,
      useLLM,
      llmMinConf,
    }) || decision;
  } catch (e) {
    console.error("[ai-dispatch] brain error:", e?.message || e);
    return ok({ ok: true, note: "brain_error_no_send" });
  }

  const outText = String(decision?.text || "").trim();
  const aiIntent = decision?.intent || "general";
  const aiMeta = decision?.meta || null;

  console.log("[ai-dispatch] brain:", { intent: aiIntent, route: aiMeta?.route, conf: aiMeta?.conf, preview: outText.slice(0, 120) });

  if (!outText) {
    // No text to send (e.g., STOP intent) -> exit quietly
    return ok({ ok: true, note: "no_text_from_brain", ai_intent: aiIntent, ai_meta: aiMeta });
  }

  // ---- send one reply via messages-send
  const sendUrl = deriveSendUrl(event);
  console.log("[ai-dispatch] OUTBOUND_SEND_URL:", sendUrl);

  if (!sendUrl) {
    console.error("[ai-dispatch] no OUTBOUND_SEND_URL; skipping send");
    return ok({ ok: false, error: "no_outbound_url", ai_intent: aiIntent, ai_meta: aiMeta });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);

  let res, json = {};
  try {
    res = await fetch(sendUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: from, body: outText, requesterId: user_id }),
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
    return ok({ ok: false, error: json?.error || `status_${res?.status}`, ai_intent: aiIntent, ai_meta: aiMeta });
  }

  // ---- tag sent message so UI shows AI badge + intent + route/conf
  try {
    if (json?.id) {
      await db.from("messages")
        .update({ meta: { sent_by_ai: true, ai_intent: aiIntent, ai_meta: aiMeta } })
        .eq("id", json.id);
    }
  } catch {}

  // ---- mark booked on confirm
  if (aiIntent === "confirm_time") {
    try { await db.from("message_contacts").update({ ai_booked: true }).eq("id", contact_id); } catch {}
  }

  return ok({ ok: true, ai: "responded", ai_intent: aiIntent, ai_meta: aiMeta });
};
