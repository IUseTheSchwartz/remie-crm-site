// netlify/functions/_push.js
// Shared helper to send Web Push notifications to all of a user's devices.
// Usage from other functions: const { sendPushToUser } = require("./_push");

const webpush = require("web-push");
const { getServiceClient } = require("./_supabase");

// Configure web-push (VAPID)
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const APP_ORIGIN = process.env.APP_ORIGIN || "";

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.warn("[_push] Missing VAPID keys; push disabled");
} else {
  webpush.setVapidDetails(`mailto:support@remiecrm.com`, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

/**
 * Send a push notification to every subscription for the given user.
 * @param {string} user_id - Auth user id
 * @param {Object} payload - { title, body, url, tag?, icon?, badge?, renotify? }
 * @returns {Promise<{ok:true, sent:number, removed:number}>}
 */
async function sendPushToUser(user_id, payload) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    return { ok: false, reason: "push_disabled" };
  }
  if (!user_id) return { ok: false, reason: "missing_user" };

  const supabase = getServiceClient();
  const { data: subs, error } = await supabase
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth")
    .eq("user_id", user_id);

  if (error) {
    console.error("[_push] db error:", error.message);
    return { ok: false, reason: "db_error" };
  }
  const list = subs || [];
  if (list.length === 0) return { ok: true, sent: 0, removed: 0 };

  let sent = 0;
  let removed = 0;

  // Normalize URL to absolute (good practice for SW click open)
  const absoluteUrl = (() => {
    try {
      const u = payload?.url || "/app";
      return new URL(u, APP_ORIGIN || "https://example.com").toString();
    } catch {
      return payload?.url || "/app";
    }
  })();

  const jsonPayload = JSON.stringify({
    title: payload?.title || "Remie CRM",
    body: payload?.body || "",
    url: absoluteUrl,
    tag: payload?.tag,
    icon: payload?.icon || "/android-chrome-192x192.png",
    badge: payload?.badge || "/favicon-32x32.png",
    renotify: !!payload?.renotify,
  });

  for (const s of list) {
    const subscription = {
      endpoint: s.endpoint,
      keys: { p256dh: s.p256dh, auth: s.auth },
    };
    try {
      await webpush.sendNotification(subscription, jsonPayload);
      sent++;
    } catch (e) {
      const status = e?.statusCode || e?.status || 0;
      // 404/410 => subscription is gone; clean it up
      if (status === 404 || status === 410) {
        try {
          await supabase.from("push_subscriptions").delete().eq("id", s.id);
          removed++;
        } catch (delErr) {
          console.warn("[_push] failed to delete dead sub:", delErr?.message || delErr);
        }
      } else {
        console.warn("[_push] send error:", status, e?.message || e);
      }
    }
  }

  return { ok: true, sent, removed };
}

module.exports = { sendPushToUser };
