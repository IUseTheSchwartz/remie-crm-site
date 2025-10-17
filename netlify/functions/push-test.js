// netlify/functions/push-test.js
const { getUserFromAuthHeader } = require("./_supabase");
const { sendPushToUser } = require("../lib/_push");

exports.handler = async (event) => {
  try {
    const user = await getUserFromAuthHeader(event);
    if (!user?.id) {
      return {
        statusCode: 401,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ok: false, error: "unauthorized" }),
      };
    }

    const payload = {
      title: "Test Push from Remie CRM",
      body: "If you see this, push is working 🎉",
      url: "/app",
      tag: "test-push",
      renotify: true,
    };

    const out = await sendPushToUser(user.id, payload);
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true, ...out }),
    };
  } catch (e) {
    console.error("[push-test] error:", e);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: false, error: e.message || String(e) }),
    };
  }
};
