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

async function insertMessageRow(supabase, {
  user_id, lead_id = null, to, from, body, status,
  provider_sid = null, cost_cents = 0, error_detail = null
}) {
  const payload = {
    user_id,
    lead_id,
    provider: "telnyx",
    provider_sid,
    direction: "outgoing",
    to_number: to,
    from_number: from,
    body: String(body || "").slice(0, 1600),
    status,
    cost_cents,
  };
  if (error_detail) payload.error_detail = String(error_detail).slice(0, 8000);

  const { error } = await supabase.from("messages").insert(payload);
  if (error) console.log("messages insert error:", error.message);
}

async function debitWalletOrThrow(supabase, userId, amount = COST_CENTS) {
  if (!userId) throw new Error("Missing requesterId for wallet debit");
  // Preferred: RPC (atomic)
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

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  const { to, body, lead_id, requesterId } = payload || {};
  const toE164 = normalizeToE164_US_CA(String(to || ""));
  const fromNumber = TELNYX_FROM_NUMBER || null;
  const statusWebhookBase = SITE_URL || URL; // may be undefined

  // Validate early — but ALWAYS log a row so it appears in UI
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    await insertMessageRow(supabase, {
      user_id: requesterId || null,
      lead_id,
      to: toE164 || String(to || ""),
      from: fromNumber,
      body,
      status: "blocked_env",
      cost_cents: 0,
      error_detail: "Supabase env not set",
    });
    return json(500, { error: "Supabase env not set" });
  }

  if (!toE164 || !body) {
    await insertMessageRow(supabase, {
      user_id: requesterId || null,
      lead_id,
      to: String(to || ""),
      from: fromNumber,
      body: body || "",
      status: "blocked_bad_number",
      cost_cents: 0,
      error_detail: !toE164 ? "Invalid `to`" : "Missing `body`",
    });
    return json(400, { error: !toE164 ? "Invalid `to` number" : "`body` is required" });
  }

  if (!TELNYX_API_KEY) {
    await insertMessageRow(supabase, {
      user_id: requesterId || null,
      lead_id,
      to: toE164,
      from: fromNumber,
      body,
      status: "blocked_env",
      cost_cents: 0,
      error_detail: "TELNYX_API_KEY not set",
    });
    return json(500, { error: "Telnyx API key not set" });
  }

  if (!TELNYX_MESSAGING_PROFILE_ID && !TELNYX_FROM_NUMBER) {
    await insertMessageRow(supabase, {
      user_id: requesterId || null,
      lead_id,
      to: toE164,
      from: fromNumber,
      body,
      status: "blocked_env",
      cost_cents: 0,
      error_detail: "Provide TELNYX_MESSAGING_PROFILE_ID or TELNYX_FROM_NUMBER",
    });
    return json(500, { error: "Provide TELNYX_MESSAGING_PROFILE_ID or TELNYX_FROM_NUMBER" });
  }

  // 1) Debit wallet (1¢). On failure, still log row.
  try {
    await debitWalletOrThrow(supabase, requesterId, COST_CENTS);
  } catch (e) {
    await insertMessageRow(supabase, {
      user_id: requesterId || null,
      lead_id,
      to: toE164,
      from: fromNumber,
      body,
      status: "blocked_insufficient_funds",
      cost_cents: 0,
      error_detail: e?.message || "Insufficient balance",
    });
    return json(402, { error: "Insufficient balance" });
  }

  // 2) Build Telnyx payload
  const msg = {
    to: toE164,
    text: String(body).slice(0, 1600),
  };
  if (TELNYX_MESSAGING_PROFILE_ID) msg.messaging_profile_id = TELNYX_MESSAGING_PROFILE_ID;
  else msg.from = TELNYX_FROM_NUMBER;

  // Optional webhooks; if not configured, we still send
  if (statusWebhookBase) {
    const statusWebhook = `${statusWebhookBase}/.netlify/functions/telnyx-status`;
    msg.webhook_url = statusWebhook;
    msg.webhook_failover_url = statusWebhook;
    msg.use_profile_webhooks = false;
  }

  // 3) Send via Telnyx
  let telnyxData = null;
  let telnyxId = null;
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

    if (!res.ok) {
      await insertMessageRow(supabase, {
        user_id: requesterId || null,
        lead_id,
        to: toE164,
        from: fromNumber,
        body,
        status: "failed",
        provider_sid: telnyxId,
        cost_cents: COST_CENTS,
        error_detail: JSON.stringify(telnyxData),
      });
      return json(502, {
        error: "Failed to send via Telnyx",
        telnyx_status: res.status,
        telnyx_response: telnyxData,
      });
    }
  } catch (e) {
    await insertMessageRow(supabase, {
      user_id: requesterId || null,
      lead_id,
      to: toE164,
      from: fromNumber,
      body,
      status: "failed",
      provider_sid: telnyxId,
      cost_cents: COST_CENTS,
      error_detail: e?.message || "Telnyx network error",
    });
    return json(502, { error: "Telnyx request failed" });
  }

  // 4) Insert the queued message row (success path)
  await insertMessageRow(supabase, {
    user_id: requesterId || null,
    lead_id,
    to: toE164,
    from: fromNumber,
    body,
    status: "queued",
    provider_sid: telnyxId,
    cost_cents: COST_CENTS,
  });

  // 5) Touch contact meta.last_outgoing_at (helps follow-up logic)
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

  return json(200, { ok: true, telnyx_id: telnyxId });
};
