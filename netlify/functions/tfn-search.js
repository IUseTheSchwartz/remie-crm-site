// File: netlify/functions/tfn-search.js
const fetch = require("node-fetch");

function json(body, status = 200) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

// Allowed toll-free prefixes (NO 800)
const ALLOWED_PREFIXES = new Set(["833", "844", "855", "866", "877", "888"]);

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "GET") return json({ error: "Method Not Allowed" }, 405);

    const API_KEY = process.env.TELNYX_API_KEY;
    if (!API_KEY) return json({ error: "TELNYX_API_KEY missing" }, 500);

    const qs = event.queryStringParameters || {};
    const prefix = String(qs.prefix || "").trim();
    if (!ALLOWED_PREFIXES.has(prefix)) {
      return json({ error: "prefix must be one of 833,844,855,866,877,888" }, 400);
    }

    const limit = Math.min(Math.max(parseInt(qs.limit || "30", 10), 1), 100);
    const page = Math.max(parseInt(qs.page || "1", 10), 1);

    // IMPORTANT: toll-free are +18xx — filter with +1{prefix}
    const url = new URL("https://api.telnyx.com/v2/available_phone_numbers");
    url.searchParams.set("phone_number_type", "toll_free");
    url.searchParams.set("starts_with", `+1${prefix}`);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("page[number]", String(page));

    const res = await fetch(url.toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return json({ error: "telnyx_search_failed", detail: data }, 502);

    const items = (data.data || [])
      // extra safety: never show +1800 numbers
      .filter((r) => typeof r.phone_number === "string" && !r.phone_number.startsWith("+1800"))
      .map((r) => ({
        id: r.id,
        phone_number: r.phone_number,
        country: r.country_code || "US",
        region: r.region || null,
      }));

    return json({ ok: true, items, meta: data.meta || null });
  } catch (e) {
    return json({ error: "unhandled", detail: String(e?.message || e) }, 500);
  }
};