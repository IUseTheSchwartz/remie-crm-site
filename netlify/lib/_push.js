// netlify/lib/_push.js
// Helper to send web push to all of a user's subscriptions.

const webpush = require("web-push");
const { getServiceClient } = require("../functions/_supabase");

const VAPID_PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const APP_ORIGIN = process.env.APP_ORIGIN || process.env.SITE_URL || "";

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.warn("[lib/_push] Missing VAPID keys; push disabled");
} else {
  webpush.setVapidDetails(
    "mailto:support@remiecrm.com",
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );
}

/**
 * Send a push notification to every subscription for the given user.
 * Returns { ok, sent, removed, errors: [{id, endpoint, status, message}] }
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
    console.error("[lib/_push] db error:", error.message);
    return { ok: false, reason: "db_error", error: error.message };
  }

  const list = subs || [];
  if (list.length === 0) return { ok: true, sent: 0, removed: 0, errors: [] };

  const absoluteUrl = (() => {
    try {
      const u = payload?.url || "/app";
      return new URL(u, APP_ORIGIN || "https://example.com").toString();
    } catch {
      return payload?.url || "/app";
    }
  })();

  const notif = {
    title: payload?.title || "Remie CRM",
    body:  payload?.body  || "",
    url:   absoluteUrl,
    tag:   payload?.tag,
    icon:  payload?.icon  || "/android-chrome-192x192.png",
    badge: payload?.badge || "/favicon-32x32.png",
    renotify: !!payload?.renotify,
  };
  const jsonPayload = JSON.stringify(notif);

  let sent = 0, removed = 0;
  const errors = [];

  for (const s of list) {
    const subscription = { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } };
    try {
      await webpush.sendNotification(subscription, jsonPayload);
      sent++;
    } catch (e) {
      const status = e?.statusCode || e?.status || 0;
      const msg = e?.message || String(e);
      console.warn("[lib/_push] send error:", status, msg);
      errors.push({ id: s.id, endpoint: s.endpoint, status, message: msg });

      if (status === 404 || status === 410) {
        try { await supabase.from("push_subscriptions").delete().eq("id", s.id); removed++; }
        catch (delErr) { console.warn("[lib/_push] cleanup failed:", delErr?.message || delErr); }
      }
    }
  }

  return { ok: true, sent, removed, errors };
}

module.exports = { sendPushToUser };