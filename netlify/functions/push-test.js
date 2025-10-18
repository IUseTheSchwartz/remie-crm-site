// netlify/functions/push-test.js
// GET /.netlify/functions/push-test  -> sends a test push to the current user (JWT required)

const { getUserFromRequest } = require("./_supabase");
const { sendPushToUser } = require("../lib/_push");

function json(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "GET") return json(405, { ok: false, error: "method_not_allowed" });

    const user = await getUserFromRequest(event);
    if (!user) return json(401, { ok: false, error: "unauthorized" });

    const result = await sendPushToUser(user.id, {
      title: "Test from Remie CRM",
      body: "It works! Tap to open Messages.",
      url: "/app/messages",
      tag: "remie-test",
      renotify: true,
    });

    console.log("[push-test] result:", result);
    return json(200, result);
  } catch (e) {
    console.error("[push-test] unhandled:", e?.message || e);
    return json(500, { ok: false, error: "server_error" });
  }
};