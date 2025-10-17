// netlify/functions/push-subscribe.js
// Save (upsert) a Web Push subscription for the logged-in user/device.

const { getServiceClient } = require("./_supabase");

function json(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, { error: "method_not_allowed" });
  }

  try {
    const supabase = getServiceClient();

    // --- Authenticate: require a Supabase JWT from the client
    const auth =
      event.headers.authorization ||
      event.headers.Authorization ||
      "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
    if (!token) return json(401, { error: "missing_bearer_token" });

    // Verify token and get the user
    const { data: userRes, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userRes?.user?.id) {
      return json(401, { error: "invalid_token" });
    }
    const user_id = userRes.user.id;

    // Parse body
    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { error: "invalid_json" });
    }

    const { subscription, userAgent } = body || {};
    if (!subscription || !subscription.endpoint || !subscription.keys) {
      return json(400, { error: "missing_subscription" });
    }

    const endpoint = String(subscription.endpoint);
    const p256dh = String(subscription.keys.p256dh || "");
    const authKey = String(subscription.keys.auth || "");
    const ua = String(userAgent || "");

    // Ensure table exists in your DB:
    // CREATE TABLE IF NOT EXISTS push_subscriptions (
    //   id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    //   user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    //   endpoint text UNIQUE NOT NULL,
    //   p256dh text NOT NULL,
    //   auth text NOT NULL,
    //   user_agent text,
    //   created_at timestamptz NOT NULL DEFAULT now(),
    //   last_seen_at timestamptz NOT NULL DEFAULT now()
    // );
    // CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);

    // Upsert by endpoint (one row per device)
    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from("push_subscriptions")
      .upsert(
        {
          user_id,
          endpoint,
          p256dh: p256dh,
          auth: authKey,
          user_agent: ua,
          last_seen_at: now,
        },
        { onConflict: "endpoint" }
      )
      .select("id, user_id, endpoint")
      .maybeSingle();

    if (error) {
      return json(500, { error: "db_error", detail: error.message });
    }

    return json(200, { ok: true, id: data?.id || null });
  } catch (e) {
    console.error("[push-subscribe] error:", e);
    return json(500, { error: "server_error" });
  }
};
