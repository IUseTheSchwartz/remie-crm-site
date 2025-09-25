const fetch = require("node-fetch");

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") return { statusCode: 405, body: "Method Not Allowed" };

  const qsIn = new URLSearchParams(event.queryStringParameters || {});
  const npa = qsIn.get("npa");
  const limit = Number(qsIn.get("limit") || 12);
  if (!npa) return { statusCode: 400, body: "npa required" };

  // Build Telnyx query (US local, voice)
  const qs = new URLSearchParams();
  qs.set("filter[country_code]", "US");
  qs.set("filter[phone_number_type]", "local");
  qs.set("filter[features]", "voice");
  qs.set("filter[national_destination_code]", npa);
  qs.set("limit", String(limit));            // <- top-level limit

  const url = `https://api.telnyx.com/v2/available_phone_numbers?${qs.toString()}`;

  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}` },
  });

  const json = await r.json();

  // Surface real errors so the UI can show them
  if (!r.ok) {
    const detail =
      (json?.errors && json.errors[0]?.detail) ||
      json?.error ||
      "Telnyx request failed";
    return {
      statusCode: r.status,
      body: JSON.stringify({ ok: false, status: r.status, error: detail, raw: json }),
    };
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true, data: json.data || [] }) };
};
