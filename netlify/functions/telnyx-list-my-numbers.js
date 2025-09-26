// File: netlify/functions/telnyx-list-my-numbers.js
const fetch = require("node-fetch");
const { getServiceClient } = require("./_supabase");

exports.handler = async (event) => {
  try {
    // Optional: gate by auth if you want (read the Supabase user from Authorization header)
    // For now, we just proxy to Telnyx and return TFNs.
    const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
    if (!TELNYX_API_KEY) {
      return { statusCode: 500, body: JSON.stringify({ error: "Missing TELNYX_API_KEY" }) };
    }

    // Pull up to 200 numbers (adjust as needed / add pagination later)
    const url = "https://api.telnyx.com/v2/phone_numbers?per_page=200";
    const r = await fetch(url, { headers: { Authorization: `Bearer ${TELNYX_API_KEY}` } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      return { statusCode: r.status, body: JSON.stringify(j) };
    }

    // Keep only toll_free, and map minimal fields we need in the UI
    const items = (j.data || [])
      .filter((p) => p.phone_number_type === "toll_free")
      .map((p) => ({
        id: p.id,
        e164: p.phone_number,
        messaging_profile_id: p.messaging_profile_id || null,
        status: p.status || "active",
        purchased_at: p.purchased_at || null,
      }));

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, numbers: items }),
      headers: { "Content-Type": "application/json" },
    };
  } catch (e) {
    console.error(e);
    return { statusCode: 500, body: JSON.stringify({ error: e.message || String(e) }) };
  }
};
