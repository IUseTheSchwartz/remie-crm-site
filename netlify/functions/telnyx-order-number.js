// netlify/functions/telnyx-order-number.js
const fetch = require("node-fetch");
const { supaAdmin } = require("./_supa");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };
  const { phone_number, agent_id, is_free } = JSON.parse(event.body || "{}");
  if (!phone_number || !agent_id) return { statusCode: 400, body: "phone_number and agent_id required" };

  // 1) Order
  const order = await fetch("https://api.telnyx.com/v2/number_orders", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ phone_numbers: [{ phone_number }] }),
  });
  const orderJson = await order.json();
  if (!order.ok) return { statusCode: 502, body: JSON.stringify(orderJson) };

  // 2) Assign to Call Control app
  const assign = await fetch("https://api.telnyx.com/v2/phone_numbers/assign", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      phone_numbers: [{ phone_number }],
      connection: { call_control_app_id: process.env.TELNYX_CALL_CONTROL_APP_ID },
    }),
  });
  const assignJson = await assign.json();
  if (!assign.ok) return { statusCode: 502, body: JSON.stringify(assignJson) };

  // 3) Save
  const supa = supaAdmin();
  const { error } = await supa.from("agent_numbers").insert({
    agent_id,
    telnyx_number: phone_number,
    is_free: !!is_free,
  });
  if (error) return { statusCode: 500, body: error.message };

  return { statusCode: 200, body: JSON.stringify({ ok: true, phone_number }) };
};
