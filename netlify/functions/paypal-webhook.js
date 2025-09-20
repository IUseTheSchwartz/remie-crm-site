import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export async function handler(event) {
  const body = JSON.parse(event.body || "{}");

  const eventType = body.event_type;
  if (eventType !== "PAYMENT.CAPTURE.COMPLETED") {
    return { statusCode: 200, body: "Ignored" };
  }

  const ref = body.resource?.supplementary_data?.related_ids?.order_id;
  const amount = body.resource?.amount?.value;
  const currency = body.resource?.amount?.currency_code;

  if (currency !== "USD") {
    return { statusCode: 200, body: "Unsupported currency" };
  }

  // Reference_id comes from our order creation
  const userRef = body.resource?.custom_id || body.resource?.invoice_id;
  const userId = userRef?.replace("wallet:", "");

  if (userId) {
    await supabase.rpc("increment_wallet_balance", {
      p_user_id: userId,
      p_delta_cents: Math.round(parseFloat(amount) * 100),
    });
  }

  return { statusCode: 200, body: "OK" };
}
