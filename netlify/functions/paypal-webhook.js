// Handles PayPal webhooks; credits wallet on PAYMENT.CAPTURE.COMPLETED
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, PAYPAL_ENV (optional for sandbox/live)
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Optional: very small idempotency helper using a table (see SQL below).
async function markProcessed(captureId) {
  const { error } = await supabase
    .from("wallet_topups")
    .insert({ provider: "paypal", provider_id: captureId })
    .select()
    .single();
  // If unique constraint blocks duplicate, error.code will be '23505'
  if (error && error.code !== "23505") throw error;
  return !error || error.code !== "23505"; // true if newly inserted
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  // NOTE: For a production-hardened setup, verify the webhook signature
  // via PayPal's verify API. This example keeps it simple to get you live.

  try {
    const payload = JSON.parse(event.body || "{}");
    const type = payload?.event_type;

    if (type !== "PAYMENT.CAPTURE.COMPLETED") {
      return { statusCode: 200, body: "Ignored" };
    }

    const capture = payload?.resource;
    const captureId = capture?.id;
    const amountStr = capture?.amount?.value;
    const currency = capture?.amount?.currency_code;
    const refField =
      capture?.custom_id ||
      capture?.supplementary_data?.related_ids?.order_id ||
      capture?.invoice_id ||
      "";

    if (currency !== "USD" || !amountStr || !captureId) {
      return { statusCode: 200, body: "Missing or unsupported fields" };
    }

    const cents = Math.round(parseFloat(amountStr) * 100);
    const userId = (refField.startsWith("wallet:") ? refField.split(":")[1] : null) || null;

    if (!userId) {
      // Nothing to credit without a user
      return { statusCode: 200, body: "No user ref" };
    }

    // Idempotency: ensure we only credit once per capture
    const isNew = await markProcessed(captureId);
    if (!isNew) {
      return { statusCode: 200, body: "Already processed" };
    }

    // Credit wallet via your RPC (see SQL below)
    const { error: rpcErr } = await supabase.rpc("increment_wallet_balance", {
      p_user_id: userId,
      p_delta_cents: cents,
    });
    if (rpcErr) throw rpcErr;

    return { statusCode: 200, body: "Wallet credited" };
  } catch (e) {
    console.error(e);
    return { statusCode: 500, body: e.message || "Webhook error" };
  }
};
