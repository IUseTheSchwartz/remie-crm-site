// File: netlify/functions/telnyx-inbound.js
// Minimal inbound: store inbound SMS, handle STOP/START, pause sequences,
// send a push to the agent, then (best-effort) call ai-dispatch.

const { getServiceClient } = require("./_supabase");
const fetch = require("node-fetch");
const { AbortController } = require("abort-controller");
const { sendPushToUser } = require("../lib/_push");

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
  const { data: owner } = await db
    .from("agent_messaging_numbers")
    .select("user_id")
    .eq("e164", telnyxToE164)
    .maybeSingle();
  if (owner?.user_id) return owner.user_id;

  const { data: m } = await db
    .from("messages")
    .select("user_id")
    .eq("from_number", telnyxToE164)
    .order("created_at", { ascending: false })
    .limit(1);
  if (m && m[0]?.user_id) return m[0].user_id;

  const SHARED =
    process.env.TELNYX_FROM ||
    process.env.TELNYX_FROM_NUMBER ||
    process.env.DEFAULT_FROM_NUMBER ||
    null;
  if (SHARED && SHARED === telnyxToE164) {
    // optional shared routing
  }

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
async function pauseLeadRescue(db, user_id, contact_id, reason) {
  const now = new Date().toISOString();
  const { error } = await db
    .from("lead_rescue_trackers")
    .update({
      paused: true,
      stop_reason: reason,
      ...(reason === "replied" ? { responded: true, responded_at: now } : {}),
      updated_at: now,
    })
    .eq("user_id", user_id)
    .eq("contact_id", contact_id);
  if (error) throw error;
}

/* ---------------- Dispatcher URL (robust) ---------------- */
function deriveDispatchUrl(event) {
  if (process.env.AI_DISPATCH_URL) {
    return String(process.env.AI_DISPATCH_URL).replace(/\/$/, "");
  }

  const base =
    process.env.SITE_URL ||
    process.env.URL ||
    process.env.DEPLOY_PRIME_URL ||
    (event?.headers &&
      `${(event.headers["x-forwarded-proto"] ||
        event.headers["X-Forwarded-Proto"] ||
        "https")}://${event.headers.host || event.headers.Host || ""}`);

  if (!base) return null;
  return `${String(base).replace(/\/$/, "")}/.netlify/functions/ai-dispatch`;
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
    console.error("[inbound] missing fields", { providerSid, from, to });
    return ok({ ok: true, note: "missing_fields" });
  }

  // dedupe by Telnyx message id
  const { data: dupe } = await db
    .from("messages")
    .select("id")
    .eq("provider", "telnyx")
    .eq("provider_sid", providerSid)
    .limit(1);
  if (dupe && dupe.length) {
    console.log("[inbound] duplicate provider_sid", providerSid);
    return ok({ ok: true, deduped: true });
  }

  const user_id = await resolveUserId(db, to);
  if (!user_id) {
    console.error("[inbound] no user for number", to);
    return ok({ ok: false, error: "no_user_for_number", to });
  }

  const contact = await findOrCreateContact(db, user_id, from);

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
  if (ins.error) {
    console.error("[inbound] insert error", ins.error);
    return ok({ ok: false, error: ins.error.message });
  }

  // Any inbound reply should pause the Lead Rescue with reason "replied"
  try { await pauseLeadRescue(db, user_id, contact.id, "replied"); } catch (e) {
    console.warn("[inbound] pauseLeadRescue(replied) warn:", e?.message || e);
  }

  const action = parseKeyword(text);

  // STOP: unsubscribe + pause rescue with reason "opted_out"
  if (action === "STOP") {
    try {
      await db.from("message_contacts").update({ subscribed: false }).eq("id", contact.id);
      await pauseLeadRescue(db, user_id, contact.id, "opted_out");
      console.log("[inbound] contact unsubscribed and rescue paused", contact.id);
    } catch (e) {
      console.warn("[inbound] STOP handling warn:", e?.message || e);
    }
    return ok({ ok: true, action: "unsubscribed" });
  }

  // START: resubscribe only (do NOT auto-resume rescue)
  if (action === "START") {
    await db.from("message_contacts").update({ subscribed: true }).eq("id", contact.id);
    console.log("[inbound] contact resubscribed (rescue remains paused until manual resume)", contact.id);
    return ok({ ok: true, action: "resubscribed" });
  }

  // Push only for real text (not STOP/START)
  if (text) {
    try {
      const who = contact?.full_name || from;
      const deepLink = `/app/messages?contact_id=${contact?.id || ""}`;
      await sendPushToUser(user_id, {
        title: `New message from ${who}`,
        body: text.slice(0, 140),
        url: deepLink,            // takes them straight to Messages
        tag: `msg-${providerSid}`,// lets notifications coalesce
        renotify: false,
      });
    } catch (e) {
      console.warn("[inbound] push notify warn:", e?.message || e);
    }
  } else {
    console.log("[inbound] empty text; skipping push and dispatch");
    return ok({ ok: true, note: "empty_text_skipped" });
  }

  // ---- await dispatch with timeout ----
  try {
    const dispatchUrl = deriveDispatchUrl(event);
    console.log("[inbound] dispatchUrl:", dispatchUrl);

    if (dispatchUrl) {
      const out = {
        provider: "telnyx",
        provider_message_id: providerSid,
        user_id,
        contact_id: contact.id,
        from,
        to,
        text,
      };
      console.log("[inbound] dispatch payload:", { ...out, text: text ? `(len=${text.length})` : "" });

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);

      let r, j = {};
      try {
        r = await fetch(dispatchUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify(out),
          signal: controller.signal,
        });
        try { j = await r.json(); } catch {}
        console.log("[inbound] ai-dispatch status:", r.status, j);
      } catch (e) {
        console.error("[inbound] ai-dispatch fetch error:", e?.name || e?.message || String(e));
      } finally {
        clearTimeout(timeout);
      }
    } else {
      console.error("[inbound] NO dispatchUrl resolved");
    }
  } catch (e) {
    console.error("[inbound] ai-dispatch block error:", e?.message || e);
  }

  return ok({ ok: true });
};
