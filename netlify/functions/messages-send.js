const { createClient } = require("@supabase/supabase-js");

/** Basic E.164 normalizer for US/CA */
function normalizeToE164_US_CA(input) {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (trimmed.startsWith("+")) {
    const compact = trimmed.replace(/\s+/g, "");
    return /^\+\d{10,15}$/.test(compact) ? compact : null;
  }
  const digits = trimmed.replace(/\D+/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

function json(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

const PRICE_CENTS = 1;

/** Insert a message row that **matches your table schema** */
async function insertMessageRow(supabase, {
  user_id, lead_id = null, to, from, body, status,
  provider_sid = null, price_cents = 0, error_detail = null,
  provider_message_id = null, segments = 1, contact_id = null,
}) {
  const payload = {
    user_id,
    contact_id,
    provider: "telnyx",
    direction: "outgoing",
    from_number: from,              // NOT NULL in your schema
    to_number: to,                  // NOT NULL
    body: String(body || "").slice(0, 1600), // NOT NULL
    status: status || "queued",     // NOT NULL
    provider_sid: provider_sid || null,
    provider_message_id: provider_message_id || null,
    segments: segments ?? 1,
    price_cents: price_cents ?? 0,
    lead_id: lead_id ?? null,
    error_detail: error_detail ? String(error_detail).slice(0, 8000) : null,
  };
  const { error } = await supabase.from("messages").insert(payload);
  if (error) {
    console.error("messages insert error:", error.message);
    throw error;
  }
}

async function debitWalletOrThrow(supabase, userId, amount = PRICE_CENTS) {
  if (!userId) throw new Error("Missing requesterId for wallet debit");
  const { data, error } = await supabase.rpc("wallet_debit", {
    p_user_id: userId,
    p_amount: amount,
  });
  if (error || data !== true) throw new Error("Insufficient balance");
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  const {
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE,
    TELNYX_API_KEY,
    TELNYX_MESSAGING_PROFILE_ID, // optional
    TELNYX_FROM_NUMBER,          // optional
    SITE_URL,
    URL,
  } = process.env;

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, {
    auth: { persistSession: false },
  });

  // Parse body
  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  const { to, body, lead_id, requesterId, contact_id } = payload || {};
  const toE164 = normalizeToE164_US_CA(String(to || ""));

  // We need a non-null from_number for DB insert; precompute a safe fallback
  // If you don't have a fixed from number, we store a placeholder that gets
  // replaced with the real number (if Telnyx returns it) on insert below.
  const fromFallback =
    TELNYX_FROM_NUMBER ||
    (TELNYX_MESSAGING_PROFILE_ID ? `profile:${TELNYX_MESSAGING_PROFILE_ID}` : "unknown");

  // Pre-checks — if any fail, we **return** early without trying to insert rows
  if (!requesterId) return json(400, { error: "Missing requesterId (user_id)" });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) return json(500, { error: "Supabase env not set" });
  if (!TELNYX_API_KEY) return json(500, { error: "Telnyx API key not set" });
  if (!TELNYX_MESSAGING_PROFILE_ID && !TELNYX_FROM_NUMBER) {
    return json(500, { error: "Provide TELNYX_MESSAGING_PROFILE_ID or TELNYX_FROM_NUMBER" });
  }
  if (!toE164) return json(400, { error: "Invalid `to` number" });
  if (!body) return json(400, { error: "`body` is required" });

  // 1) Debit wallet (1¢)
  try {
    await debitWalletOrThrow(supabase, requesterId, PRICE_CENTS);
  } catch (e) {
    // We can choose to log a blocked row, but your table has user_id NOT NULL,
    // so if requesterId is missing this would fail anyway. Here we just return.
    return json(402, { error: e?.message || "Insufficient balance" });
  }

  // 2) Build Telnyx payload
  const msg = {
    to: toE164,
    text: String(body).slice(0, 1600),
  };
  if (TELNYX_MESSAGING_PROFILE_ID) msg.messaging_profile_id = TELNYX_MESSAGING_PROFILE_ID;
  else msg.from = TELNYX_FROM_NUMBER;

  const statusWebhookBase = SITE_URL || URL;
  if (statusWebhookBase) {
    const statusWebhook = `${statusWebhookBase}/.netlify/functions/telnyx-status`;
    msg.webhook_url = statusWebhook;
    msg.webhook_failover_url = statusWebhook;
    msg.use_profile_webhooks = false;
  }

  // 3) Send via Telnyx
  let telnyxData = null;
  let telnyxId = null;
  let telnyxFrom = null;
  let providerMsgId = null;
  let segments = 1;

  try {
    const res = await fetch("https://api.telnyx.com/v2/messages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TELNYX_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(msg),
    });

    telnyxData = await res.json().catch(() => ({}));
    telnyxId = telnyxData?.data?.id || telnyxData?.id || null;
    telnyxFrom =
      telnyxData?.data?.from?.phone_number ||
      telnyxData?.data?.from ||
      null;
    providerMsgId = telnyxData?.data?.record_type || null; // no canonical provider_message_id in Telnyx; keep optional
    segments = telnyxData?.data?.num_segments || 1;

    if (!res.ok) {
      // Insert a failed row (still requires NOT NULL from_number)
      const fromUsed = telnyxFrom || fromFallback;
      await insertMessageRow(supabase, {
        user_id: requesterId,
        contact_id: contact_id ?? null,
        lead_id: lead_id ?? null,
        to: toE164,
        from: fromUsed,
        body,
        status: "failed",
        provider_sid: telnyxId,
        provider_message_id: providerMsgId,
        price_cents: PRICE_CENTS,
        segments,
        error_detail: JSON.stringify(telnyxData),
      });
      return json(502, {
        error: "Failed to send via Telnyx",
        telnyx_status: res.status,
        telnyx_response: telnyxData,
      });
    }
  } catch (e) {
    const fromUsed = telnyxFrom || fromFallback;
    await insertMessageRow(supabase, {
      user_id: requesterId,
      contact_id: contact_id ?? null,
      lead_id: lead_id ?? null,
      to: toE164,
      from: fromUsed,
      body,
      status: "failed",
      provider_sid: telnyxId,
      provider_message_id: providerMsgId,
      price_cents: PRICE_CENTS,
      segments,
      error_detail: e?.message || "Telnyx network error",
    });
    return json(502, { error: "Telnyx request failed" });
  }

  // 4) Success → insert queued row with a guaranteed from_number
  const fromUsed = telnyxFrom || TELNYX_FROM_NUMBER || fromFallback;

  await insertMessageRow(supabase, {
    user_id: requesterId,
    contact_id: contact_id ?? null,
    lead_id: lead_id ?? null,
    to: toE164,
    from: fromUsed,
    body,
    status: "queued",
    provider_sid: telnyxId,
    provider_message_id: providerMsgId,
    price_cents: PRICE_CENTS,
    segments,
  });

  // 5) Optional: touch contact meta.last_outgoing_at (if you keep that field)
  try {
    const { data: contact } = await supabase
      .from("message_contacts")
      .select("id, meta")
      .eq("user_id", requesterId)
      .eq("phone", toE164)
      .maybeSingle();
    if (contact?.id) {
      await supabase
        .from("message_contacts")
        .update({ meta: { ...(contact.meta || {}), last_outgoing_at: new Date().toISOString() } })
        .eq("id", contact.id);
    }
  } catch {}

  return json(200, { ok: true, telnyx_id: telnyxId, from_number: fromUsed });
};
