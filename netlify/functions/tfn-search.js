// File: netlify/functions/tfn-search.js
const fetch = require("node-fetch");

function json(body, status = 200) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "GET") return json({ error: "Method Not Allowed" }, 405);

    const API_KEY = process.env.TELNYX_API_KEY;
    if (!API_KEY) return json({ error: "TELNYX_API_KEY missing" }, 500);

    const qs = event.queryStringParameters || {};
    const prefix = String(qs.prefix || "").trim();

    // 800 is NOT allowed
    const ALLOWED = new Set(["833", "844", "855", "866", "877", "888"]);
    if (!ALLOWED.has(prefix)) {
      return json({ error: "prefix must be one of 833,844,855,866,877,888" }, 400);
    }

    const limit = Math.min(Math.max(parseInt(qs.limit || "30", 10), 1), 100);
    const page = Math.max(parseInt(qs.page || "1", 10), 1);

    // Telnyx search
    const url = new URL("https://api.telnyx.com/v2/available_phone_numbers");
    url.searchParams.set("phone_number_type", "toll_free");
    // Be explicit: E.164 +1{prefix}
    url.searchParams.set("starts_with", `+1${prefix}`);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("page[number]", String(page));

    const res = await fetch(url.toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return json({ error: "telnyx_search_failed", detail: data }, 502);
    }

    // Normalize & hard-filter: only +1{prefix}*, and NEVER +1800*
    const items = (data.data || [])
      .map((r) => ({
        id: r.id,
        phone_number: r.phone_number, // E.164
        country: r.country_code || "US",
        region: r.region || null,
      }))
      .filter((n) => {
        const pn = String(n.phone_number || "");
        // must start with this tab's prefix
        if (!pn.startsWith(`+1${prefix}`)) return false;
        // extra guard: never allow +1800...
        if (pn.startsWith("+1800")) return false;
        return true;
      });

    return json({ ok: true, items, meta: data.meta || null });
  } catch (e) {
    return json({ error: "unhandled", detail: String(e?.message || e) }, 500);
  }
};