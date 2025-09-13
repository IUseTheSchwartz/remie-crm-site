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

const COST_CENTS = 1;

async function debitWalletOrThrow(supabase, userId, amount = COST_CENTS) {
  if (!userId) throw new Error("Missing requesterId for wallet debit");

  // 1) Try RPC (recommended)
  try {
    const { data, error } = await supabase.rpc("wallet_debit", {
      p_user_id: userId,
      p_amount: amount,
    });
    if (error || data !== true) throw error || new Error("Insufficient balance");
    return;
  } catch (e) {
    // 2) Fallback: guarded read+write (not fully atomic, but better than nothing)
    const { data: row, error: selErr } = await supabase
      .from("user_wallets")
      .select("balance_cents")
      .eq("user_id", userId)
      .maybeSingle();
    if (selErr || !row) throw new Error("Wallet not found");
    if ((row.balance_cents ?? 0) < amount) throw new Error("Insufficient balance");
    const { error: updErr } = await supabase
      .from("user_wallets")
      .update({ balance_cents: (row.balance_cents ?? 0) - amount })
      .eq("user_id", userId);
    if (updErr) throw new Error("Wallet debit failed");
  }
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

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    return json(500, { error: "Supabase env not set" });
  }
  if (!TELNYX_API_KEY) {
    return json(500, { error: "Telnyx API key not set" });
  }
  // Allow EITHER messaging profile OR from number
  if (!TELNYX_MESSAGING_PROFILE_ID && !TELNYX_FROM_NUMBER) {
    return json(500, { error: "Provide TELNYX_MESSAGING_PROFILE_ID or TELNYX_FROM_NUMBER" });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  const { to, body, lead_id, requesterId } = payload || {};
  if (!to || !body) {
    return json(400, { error: "`to` and `body` are required" });
  }
  if (Array.isArray(to)) {
    return json(400, { error: "`to` must be a single phone number string, not an array" });
  }

  const toE164 = normalizeToE164_US_CA(String(to));
  if (!toE164) {
    return json(400, {
      error: "Invalid `to` number",
      hint: "Use a single E.164 number like +16155551234 (US/CA).",
      got: String(to),
    });
  }

  const statusWebhookBase = SITE_URL || URL;
  if (!statusWebhookBase) {
    return json(500, { error: "SITE_URL or URL must be set for webhooks" });
  }
  const statusWebhook = `${statusWebhookBase}/.netlify/functions/telnyx-status`;

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, {
    auth: { persistSession: false },
  });

  // 0) Debit wallet first (1¢)
  try {
    await debitWalletOrThrow(supabase, requesterId, COST_CENTS);
  } catch (e) {
    return json(402, { error: e.message || "Insufficient balance" });
  }

  // 1) Build Telnyx payload
  const msg = {
    to: toE164,
    text: String(body),
    webhook_url: statusWebhook,
    webhook_failover_url: statusWebhook,
    use_profile_webhooks: false,
  };
  if (TELNYX_MESSAGING_PROFILE_ID) {
    msg.messaging_profile_id = TELNYX_MESSAGING_PROFILE_ID;
  } else {
    msg.from = TELNYX_FROM_NUMBER;
  }

  const tRes = await fetch("https://api.telnyx.com/v2/messages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TELNYX_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(msg),
  });

  let tData = null;
  try {
    tData = await tRes.json();
  } catch {
    tData = null;
  }
  const telnyxId = tData?.data?.id || tData?.id || null;

  // 2) On Telnyx failure: log failed message (you could refund here if you want)
  if (!tRes.ok) {
    await supabase.from("messages").insert({
      user_id: requesterId || null,
      lead_id: lead_id ?? null,
      provider: "telnyx",
      provider_sid: telnyxId,
      direction: "outgoing",
      to_number: toE164,
      from_number: TELNYX_FROM_NUMBER || null,
      body: String(body),
      status: "failed",
      cost_cents: COST_CENTS,
      error_detail: JSON.stringify(tData || { status: tRes.status }).slice(0, 8000),
    });
    return json(502, {
      error: "Failed to send via Telnyx",
      telnyx_status: tRes.status,
      telnyx_response: tData,
    });
  }

  // 3) Insert queued message
  const { error: dbErr } = await supabase.from("messages").insert({
    user_id: requesterId || null,
    lead_id: lead_id ?? null,
    provider: "telnyx",
    provider_sid: telnyxId,
    direction: "outgoing",
    to_number: toE164,
    from_number: TELNYX_FROM_NUMBER || null,
    body: String(body),
    status: "queued",
    cost_cents: COST_CENTS,
  });

  // 4) Touch contact meta.last_outgoing_at (keeps your 48h nudge logic accurate)
  try {
    const { data: contact } = await supabase
      .from("message_contacts")
      .select("id, meta")
      .eq("user_id", requesterId || null)
      .eq("phone", toE164)
      .maybeSingle();
    if (contact?.id) {
      await supabase
        .from("message_contacts")
        .update({ meta: { ...(contact.meta || {}), last_outgoing_at: new Date().toISOString() } })
        .eq("id", contact.id);
    }
  } catch {}

  if (dbErr) {
    return json(200, {
      ok: true,
      telnyx_id: telnyxId,
      warning: "Sent but failed to insert message row",
      db_error: dbErr.message,
    });
  }

  return json(200, { ok: true, telnyx_id: telnyxId });
};
