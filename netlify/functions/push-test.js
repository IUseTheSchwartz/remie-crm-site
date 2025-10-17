// netlify/functions/push-test.js
const { sendPushToUser } = require("./_push");

// light-weight JWT "sub" extractor (no verification needed for our purpose)
function getUserIdFromAuthHeader(event) {
  const h = event.headers || {};
  const auth = h.authorization || h.Authorization || "";
  if (!auth.startsWith("Bearer ")) return null;
  try {
    const token = auth.slice(7);
    const [, payload] = token.split(".");
    const json = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
    return json.sub || json.user_id || null;
  } catch {
    return null;
  }
}

function json(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { error: "method_not_allowed" });
    }

    const user_id = getUserIdFromAuthHeader(event);
    if (!user_id) return json(401, { error: "missing_or_bad_bearer" });

    const result = await sendPushToUser(user_id, {
      title: "🔔 Test push from Remie",
      body: "If you tap this, it should open the app.",
      url: "/app",
      tag: "test",
      renotify: true,
    });

    return json(200, { ok: true, ...result });
  } catch (e) {
    console.error("[push-test] error:", e);
    return json(500, { error: "server_error", detail: e.message || String(e) });
  }
};
