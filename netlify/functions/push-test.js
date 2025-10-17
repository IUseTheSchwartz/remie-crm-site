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
// File: netlify/functions/push-test.js
// Authenticated test sender with verbose logging so we can diagnose 502s.

const { getServiceClient } = require("./_supabase");
const { sendPushToUser } = require("./_push");

function json(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  try {
    const supabase = getServiceClient();

    // --- 1) Auth: require Bearer token (from the app page) ---
    const auth = event.headers.authorization || event.headers.Authorization || "";
    const m = auth.match(/^Bearer\s+(.+)$/i);
    const jwt = m?.[1];
    if (!jwt) {
      return json(401, { ok: false, error: "missing_bearer_token" });
    }

    const { data: userData, error: userErr } = await supabase.auth.getUser(jwt);
    if (userErr || !userData?.user) {
      return json(401, { ok: false, error: "invalid_token", detail: userErr?.message });
    }
    const user_id = userData.user.id;

    // --- 2) Quick env + subscription diagnostics ---
    const hasVapidPub = !!process.env.VAPID_PUBLIC_KEY;
    const hasVapidPriv = !!process.env.VAPID_PRIVATE_KEY;

    const { data: subs, error: subsErr } = await supabase
      .from("push_subscriptions")
      .select("id, endpoint")
      .eq("user_id", user_id);

    if (subsErr) {
      return json(500, { ok: false, error: "db_subscriptions_error", detail: subsErr.message });
    }

    // --- 3) If no subs or missing keys, surface that clearly ---
    if (!hasVapidPub || !hasVapidPriv) {
      return json(500, {
        ok: false,
        error: "missing_vapid_keys",
        diag: {
          VAPID_PUBLIC_KEY_present: hasVapidPub,
          VAPID_PRIVATE_KEY_present: hasVapidPriv,
          subscriptions_found: subs?.length || 0,
        },
      });
    }

    if (!subs || subs.length === 0) {
      return json(200, {
        ok: true,
        sent: 0,
        removed: 0,
        note: "no_subscriptions_found_for_user",
      });
    }

    // --- 4) Attempt to send ---
    const result = await sendPushToUser(user_id, {
      title: "Remie CRM",
      body: "Test push ✅",
      url: "/app/messages",
      tag: "debug-test",
      renotify: false,
    });

    // Include some helpful diag back
    return json(200, {
      ok: !!result?.ok,
      ...result,
      diag: {
        user_id,
        subscriptions_found: subs.length,
        VAPID_PUBLIC_KEY_present: hasVapidPub,
        VAPID_PRIVATE_KEY_present: hasVapidPriv,
      },
    });
  } catch (e) {
    // Catch-all so Netlify doesn’t surface a 502 with no details
    return json(500, {
      ok: false,
      error: "unhandled_exception",
      detail: e?.message || String(e),
      stack: e?.stack,
    });
  }
};
