// netlify/functions/telnyx-direct-test.js
// Simple Telnyx "can we send?" smoke test with verbose logs.

exports.handler = async (event) => {
  try {
    const apiKey   = process.env.TELNYX_API_KEY;
    const profile  = process.env.TELNYX_MESSAGING_PROFILE_ID;
    const from     = process.env.TELNYX_FROM;
    const fallbackTo = process.env.TELNYX_TEST_TO;

    // Allow overriding via querystring (?to=+1555..., ?text=Hello)
    const qs = event.queryStringParameters || {};
    const to   = (qs.to || fallbackTo || "").trim();
    const text = (qs.text || "Telnyx direct send test from Netlify").toString();

    const missing = [];
    if (!apiKey)  missing.push("TELNYX_API_KEY");
    if (!profile) missing.push("TELNYX_MESSAGING_PROFILE_ID");
    if (!from)    missing.push("TELNYX_FROM");
    if (!to)      missing.push("TELNYX_TEST_TO or ?to= param");
    if (missing.length) {
      return {
        statusCode: 400,
        body: JSON.stringify({ ok:false, error:`Missing env/param: ${missing.join(", ")}` })
      };
    }

    console.log("[telnyx-test] sending", { from, to, profile, text });

    const res = await fetch("https://api.telnyx.com/v2/messages", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from,
        to,
        text,
        messaging_profile_id: profile
      })
    });

    const body = await res.json().catch(() => ({}));
    console.log("[telnyx-test] telnyx status", res.status, body);

    return {
      statusCode: res.ok ? 200 : res.status,
      body: JSON.stringify({
        ok: res.ok,
        status: res.status,
        telnyx: body
      })
    };
  } catch (err) {
    console.error("[telnyx-test] error", err);
    return { statusCode: 500, body: JSON.stringify({ ok:false, error: String(err && err.message || err) }) };
  }
};
