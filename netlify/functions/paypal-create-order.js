// netlify/functions/paypal-create-order.js

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    },
    body: JSON.stringify(body),
  };
}

function paypalHost(envRaw) {
  const env = String(envRaw || "").toLowerCase();
  if (env === "sandbox") return "https://api.sandbox.paypal.com";
  // anything else is LIVE
  return "https://api-m.paypal.com";
}

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, { ok: true });
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  try {
    const { amount_cents, user_id } = JSON.parse(event.body || "{}");
    if (!amount_cents || !user_id) return json(400, { error: "Missing amount_cents or user_id" });

    const host = paypalHost(process.env.PAYPAL_ENV);
    const clientId = process.env.PAYPAL_CLIENT_ID;
    const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
    if (!clientId || !clientSecret) return json(500, { error: "PayPal credentials not set" });

    // 1) OAuth
    const tokenRes = await fetch(`${host}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    const token = await tokenRes.json();
    if (!tokenRes.ok) {
      return json(tokenRes.status, { error: "PayPal OAuth failed", details: token });
    }

    // 2) Create order
    const orderRes = await fetch(`${host}/v2/checkout/orders`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [
          {
            reference_id: user_id, // we'll use this in the webhook to credit the right user
            amount: {
              currency_code: "USD",
              value: (amount_cents / 100).toFixed(2),
            },
          },
        ],
      }),
    });

    const order = await orderRes.json();
    if (!orderRes.ok) {
      return json(orderRes.status, { error: "PayPal create order failed", details: order });
    }

    return json(200, order);
  } catch (err) {
    console.error("paypal-create-order error", err);
    return json(500, { error: "Failed to create order", details: String(err?.message || err) });
  }
};
