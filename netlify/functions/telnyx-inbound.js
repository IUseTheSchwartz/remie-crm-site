// Minimal inbound: store inbound SMS, handle STOP/START, pause sequences,
// then fire-and-forget to ai-dispatch for the reply logic.

const { getServiceClient } = require("./_supabase");
const fetch = require("node-fetch");

function ok(body) {
  return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || { ok: true }) };
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

// Resolve agent by the Telnyx "to" number
async function resolveUserId(db, telnyxToE164) {
  const { data: owner } = await db.from("agent_messaging_numbers").select("user_id").eq("e164", telnyxToE164).maybeSingle();
  if (owner?.user_id) return owner.user_id;

  const { data: m } = await db
    .from("messages")
    .select("user_id")
    .eq("from_number", telnyxToE164)
    .order("created_at", { ascending: false })
    .limit(1);
  if (m && m[0]?.user_id) return m[0].user_id;

  const SHARED =
    process.env.TELNYX_FROM || process.env.TELNYX_FROM_NUMBER || process.env.DEFAULT_FROM_NUMBER || null;
  if (SHARED && SHARED === telnyxToE164) { /* optional shared routing */ }

  return process.env.INBOUND_FALLBACK_USER_ID || process.env.DEFAULT_USER_ID || null;
}

async function findOrCreateContact(db, user_id, fromE164) {
  const last10 = norm10(fromE164);
  const { data } = await db
    .from("message_contacts")
    .select("id, phone, subscribed, ai_booked, full_name")
    .eq("user_id", user_id);
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
  const normalized = raw.toUpperCase().replace(/[^A-Z]/g, "");
  const STOP_SET = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);
  const START_SET = new Set(["START", "YES", "UNSTOP"]);
  const treatNo = String(process.env.INBOUND_TREAT_NO_AS_STOP || "true").toLowerCase() === "true";
  if (treatNo && normalized === "NO") return "STOP";
  if (STOP_SET.has(normalized)) return "STOP";
  if (START_SET.has(normalized)) return "START";
  return null;
}

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

function deriveDispatchUrl(event) {
  const base =
    process.env.SITE_URL ||
    process.env.URL ||
    process.env.DEPLOY_PRIME_URL ||
    (event.headers && `${(event.headers["x-forwarded-proto"] || event.headers["X-Forwarded-Proto"] || "https")}://${event.headers.host || event.headers.Host}`);
  if (!base) return null;
  return `${String(base).replace(/\/$/, "")}/.netlify/functions/ai-dispatch`;
}

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

  if (!providerSid || !from || !to) return ok({ ok: true, note: "missing_fields" });

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

  // Ensure contact & insert inbound
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
  if (ins.error) return ok({ ok: false, error: ins.error.message });

  // Pause any sequence
  try { await stopLeadRescueOnReply(db, user_id, contact.id); } catch {}

  // STOP/START
  const action = parseKeyword(text);
  if (action === "STOP") {
    await db.from("message_contacts").update({ subscribed: false }).eq("id", contact.id);
    return ok({ ok: true, action: "unsubscribed" });
  }
  if (action === "START") {
    await db.from("message_contacts").update({ subscribed: true }).eq("id", contact.id);
    return ok({ ok: true, action: "resubscribed" });
  }

  // Fire-and-forget AI dispatch (don’t block Telnyx response)
  try {
    const dispatchUrl = deriveDispatchUrl(event);
    if (dispatchUrl) {
      fetch(dispatchUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id, contact_id: contact.id, from, to, text }),
      }).catch(() => {});
    }
  } catch {}

  return ok({ ok: true });
};