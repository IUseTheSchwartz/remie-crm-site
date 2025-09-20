// netlify/functions/paypal-create-order.js
import fetch from "node-fetch";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { amount_cents, user_id } = req.body || {};
    if (!amount_cents || !user_id) return res.status(400).json({ error: "Missing amount_cents or user_id" });

    const PAYPAL_ENV = (process.env.PAYPAL_ENV || "sandbox").toLowerCase(); // "sandbox" or "api-m"
    const host = PAYPAL_ENV === "sandbox" ? "https://api.sandbox.paypal.com" : "https://api-m.paypal.com";
    const clientId = process.env.PAYPAL_CLIENT_ID;
    const clientSecret = process.env.PAYPAL_CLIENT_SECRET;

    // OAuth token
    const tokenRes = await fetch(`${host}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    const token = await tokenRes.json();
    if (!token.access_token) throw new Error("Failed to get PayPal token");

    // Create order
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
            reference_id: user_id, // we use this to know which user to credit
            amount: {
              currency_code: "USD",
              value: (amount_cents / 100).toFixed(2),
            },
          },
        ],
      }),
    });

    const order = await orderRes.json();
    if (!order?.id) return res.status(500).json({ error: "Failed to create PayPal order" });
    return res.status(200).json(order);
  } catch (err) {
    console.error("paypal-create-order error", err);
    return res.status(500).json({ error: "Failed to create order" });
  }
}
