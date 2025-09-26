// /.netlify/functions/tfn-search.js
const fetch = require("node-fetch");

const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const DEFAULT_PREFIX = process.env.TELNYX_TFN_DEFAULT_PREFIX || "888";

function json(body, statusCode = 200) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "GET") return json({ error: "Method Not Allowed" }, 405);
    if (!TELNYX_API_KEY) return json({ error: "Missing TELNYX_API_KEY" }, 500);

    const url = new URL(event.rawUrl || `http://x/?${event.rawQueryString || ""}`);
    const prefix = url.searchParams.get("prefix") || DEFAULT_PREFIX; // 833/844/855/866/877/888
    const page = Number(url.searchParams.get("page") || "1");
    const size = Math.min(50, Math.max(1, Number(url.searchParams.get("size") || "25")));

    const qs = new URLSearchParams({
      type: "toll_free",
      national_destination_code: prefix,
      "page[number]": String(page),
      "page[size]": String(size),
    });

    const res = await fetch(`https://api.telnyx.com/v2/available_phone_numbers?${qs.toString()}`, {
      headers: { Authorization: `Bearer ${TELNYX_API_KEY}` },
    });

    const out = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = out?.errors?.[0]?.detail || JSON.stringify(out);
      return json({ error: "telnyx_search_failed", detail: msg }, res.status);
    }

    // Normalize list
    const numbers = (out.data || []).map((d) => ({
      phone_number: d.phone_number,
      region: d.region || null,
      billing_methods: d.billing_methods || null,
    }));

    // Telnyx includes meta with pagination sometimes
    const meta = out.meta || {};

    return json({ ok: true, numbers, meta, page, size, prefix });
  } catch (e) {
    return json({ error: "unhandled", detail: String(e?.message || e) }, 500);
  }
};
