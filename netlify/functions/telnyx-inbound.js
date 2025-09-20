// File: netlify/functions/telnyx-inbound.js
// Inserts incoming SMS and handles STOP/START style opt-out/opt-in.
// Also marks Lead Rescue as responded (stops the sequence).

const { getServiceClient } = require("./_supabase");

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

async function resolveUserId(db, telnyxToE164) {
  // A) Most recent outgoing message that used this Telnyx number as "from"
  const { data: m } = await db
    .from("messages")
    .select("user_id")
    .eq("from_number", telnyxToE164)
    .order("created_at", { ascending: false })
    .limit(1);
  if (m && m[0]?.user_id) return m[0].user_id;

  // B) Agent profile with matching phone
  const ap = await db
    .from("agent_profiles")
    .select("user_id")
    .eq("phone", telnyxToE164)
    .maybeSingle();
  if (ap?.data?.user_id) return ap.data.user_id;

  // C) Fallback env (optional)
  return process.env.INBOUND_FALLBACK_USER_ID || process.env.DEFAULT_USER_ID || null;
}

async function findOrCreateContact(db, user_id, fromE164) {
  const last10 = norm10(fromE164);
  const { data, error } = await db
    .from("message_contacts")
    .select("id, phone, subscribed")
    .eq("user_id", user_id);
  if (error) throw error;

  const found = (data || []).find((c) => norm10(c.phone) === last10);
  if (found) return found;

  const ins = await db
    .from("message_contacts")
    .insert([{ user_id, phone: fromE164, subscribed: true }])
    .select("id, phone, subscribed")
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

  // NEW: any inbound reply stops Lead Rescue
  await stopLeadRescueOnReply(db, user_id, contact.id);

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

  return ok({ ok: true });
};