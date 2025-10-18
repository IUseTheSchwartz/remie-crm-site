// netlify/functions/push-subscribe.js
// Stores a browser's push subscription for the logged-in user.

const { getServiceClient, getUserFromAuthHeader, getUserFromRequest } = require("./_supabase");

function json(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

exports.handler = async (event) => {
  const supabase = getServiceClient();
  const method = event.httpMethod || "GET";
  const authHeader = event.headers?.authorization || event.headers?.Authorization || "";
  const hasBearer = typeof authHeader === "string" && authHeader.startsWith("Bearer ");

  console.log("[push-subscribe] method:", method, "hasBearer:", !!hasBearer);

  if (method !== "POST") return json(405, { error: "method_not_allowed" });

  // 1) Auth — try both helpers
  let user = null;
  try {
    user = await getUserFromAuthHeader(event);
  } catch (e) {
    console.error("[push-subscribe] getUserFromAuthHeader threw:", e?.message || e);
  }
  if (!user) {
    try {
      user = await getUserFromRequest(event);
    } catch {}
  }
  if (!user) {
    console.error("[push-subscribe] unauthorized: no user from token");
    return json(401, { error: "unauthorized_no_user" });
  }

  // 2) Parse body
  let body = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    console.error("[push-subscribe] bad_json:", e?.message || e);
    return json(400, { error: "bad_json" });
  }

  const endpoint = String(body?.endpoint || "").trim();
  const p256dh = body?.keys?.p256dh || body?.p256dh || "";
  const auth = body?.keys?.auth || body?.auth || "";
  const platform = (body?.platform || "web").slice(0, 20);
  const topics = Array.isArray(body?.topics) ? body.topics : [];

  if (!endpoint || !p256dh || !auth) {
    console.error("[push-subscribe] missing_subscription_fields", {
      hasEndpoint: !!endpoint,
      hasP256: !!p256dh,
      hasAuth: !!auth,
    });
    return json(400, { error: "missing_subscription_fields" });
  }

  // 3) Upsert
  const row = {
    user_id: user.id,
    endpoint,
    p256dh,
    auth,
    platform,
    topics,
    created_at: new Date().toISOString(),
  };

  const { error } = await supabase
    .from("push_subscriptions")
    .upsert(row, { onConflict: "user_id,endpoint" });

  if (error) {
    console.error("[push-subscribe] db_error:", error.message);
    return json(500, { error: "db_error", detail: error.message });
  }

  console.log("[push-subscribe] saved for user:", user.id);
  return json(200, { ok: true });
};
