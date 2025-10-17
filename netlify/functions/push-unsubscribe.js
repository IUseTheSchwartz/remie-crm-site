// netlify/functions/push-unsubscribe.js
// Remove a stored Web Push subscription for the logged-in user/device.

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

    // Require Supabase JWT to ensure only the owner can remove their subscription
    const auth =
      event.headers.authorization ||
      event.headers.Authorization ||
      "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
    if (!token) return json(401, { error: "missing_bearer_token" });

    const { data: userRes, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userRes?.user?.id) {
      return json(401, { error: "invalid_token" });
    }
    const user_id = userRes.user.id;

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { error: "invalid_json" });
    }

    const endpoint = String(body.endpoint || "");
    if (!endpoint) return json(400, { error: "missing_endpoint" });

    const { error } = await supabase
      .from("push_subscriptions")
      .delete()
      .eq("user_id", user_id)
      .eq("endpoint", endpoint);

    if (error) return json(500, { error: "db_error", detail: error.message });

    return json(200, { ok: true });
  } catch (e) {
    console.error("[push-unsubscribe] error:", e);
    return json(500, { error: "server_error" });
  }
};
