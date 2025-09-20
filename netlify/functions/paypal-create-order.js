// Creates a PayPal order for wallet top-ups
// Env: PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_ENV=live|sandbox
const API_BASE =
  (process.env.PAYPAL_ENV || "live").toLowerCase() === "sandbox"
    ? "https://api-m.sandbox.paypal.com"
    : "https://api-m.paypal.com";

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  try {
    const { amount_cents, user_id } = JSON.parse(event.body || "{}");
    if (!amount_cents || !user_id) {
      return { statusCode: 400, body: "Missing amount_cents or user_id" };
    }

    // 1) OAuth token
    const basic = Buffer.from(
      `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`
    ).toString("base64");

    const tokRes = await fetch(`${API_BASE}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });

    if (!tokRes.ok) {
      const text = await tokRes.text();
      return { statusCode: 502, body: `PayPal auth failed: ${text}` };
    }
    const { access_token } = await tokRes.json();

    // 2) Create order
    const dollars = (Number(amount_cents) / 100).toFixed(2);
    const ordRes = await fetch(`${API_BASE}/v2/checkout/orders`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [
          {
            amount: { currency_code: "USD", value: dollars },
            reference_id: `wallet:${user_id}`,
            custom_id: `wallet:${user_id}`, // we’ll read this in the webhook
          },
        ],
        application_context: {
          shipping_preference: "NO_SHIPPING",
          user_action: "PAY_NOW",
        },
      }),
    });

    const order = await ordRes.json();
    if (!ordRes.ok) {
      return {
        statusCode: 502,
        body: JSON.stringify({ error: order?.message || "PayPal create order failed", details: order }),
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ id: order.id }),
    };
  } catch (e) {
    return { statusCode: 500, body: e.message || "Server error" };
  }
};
