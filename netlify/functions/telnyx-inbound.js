// Minimal inbound handler: insert incoming SMS into public.messages

const { getServiceClient } = require("./_supabase");

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

async function resolveUserId(db, telnyxToE164) {
  // A) Most recent outgoing message that used this Telnyx number as "from"
  let { data } = await db
    .from("messages")
    .select("user_id")
    .eq("from_number", telnyxToE164)
    .order("created_at", { ascending: false })
    .limit(1);
  if (data && data[0]?.user_id) return data[0].user_id;

  // B) Agent profile with matching phone
  let ap = await db
    .from("agent_profiles")
    .select("user_id")
    .eq("phone", telnyxToE164)
    .maybeSingle();
  if (ap?.data?.user_id) return ap.data.user_id;

  // C) Fallback env (set this in Netlify if needed)
  return process.env.INBOUND_FALLBACK_USER_ID || process.env.DEFAULT_USER_ID || null;
}

async function findOrCreateContact(db, user_id, fromE164) {
  const last10 = norm10(fromE164);
  const { data, error } = await db
    .from("message_contacts")
    .select("id, phone")
    .eq("user_id", user_id);
  if (error) throw error;
  const found = (data || []).find((c) => norm10(c.phone) === last10);
  if (found) return found.id;

  const ins = await db
    .from("message_contacts")
    .insert([{ user_id, phone: fromE164, subscribed: true }])
    .select("id")
    .maybeSingle();
  if (ins.error) throw ins.error;
  return ins.data.id;
}

exports.handler = async (event) => {
  const db = getServiceClient();

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}

  const data = body.data || body;
  const payload = data.payload || data;

  const providerSid = payload?.id || data?.id || null;
  const from = toE164(payload?.from?.phone_number || payload?.from || "");
  const to = toE164((Array.isArray(payload?.to) && payload.to[0]?.phone_number) || payload?.to || "");
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

  let contact_id = null;
  try { contact_id = await findOrCreateContact(db, user_id, from); } catch {}

  const row = {
    user_id,
    contact_id,
    direction: "incoming",
    provider: "telnyx",
    from_number: from,
    to_number: to,
    body: text,
    status: "received",
    provider_sid: providerSid,
    price_cents: 0,
  };

  const { error } = await db.from("messages").insert([row]);
  if (error) return ok({ ok: false, error: error.message });

  return ok({ ok: true });
};
