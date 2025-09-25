// netlify/functions/telnyx-app-check.js
const fetch = require("node-fetch");

exports.handler = async () => {
  try {
    const apiKey = process.env.TELNYX_API_KEY;
    const appId = process.env.TELNYX_CALL_CONTROL_APP_ID;
    if (!apiKey || !appId) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          ok: false,
          error: "Missing TELNYX_API_KEY or TELNYX_CALL_CONTROL_APP_ID",
        }),
      };
    }
    const res = await fetch(
      `https://api.telnyx.com/v2/call_control_apps/${appId}`,
      { headers: { Authorization: `Bearer ${apiKey}` } }
    );
    const data = await res.json().catch(() => ({}));
    return {
      statusCode: res.status,
      body: JSON.stringify({ ok: res.ok, app: data?.data || data }),
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
