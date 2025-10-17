// netlify/functions/push-subscribe.js
// Saves a browser/device push subscription for the logged-in user.

const { getServiceClient, getUserFromAuthHeader } = require("./_supabase");

function json(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  const supabase = getServiceClient();

  // CORS for safety (Netlify runs same-origin, but keep this handy)
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization,content-type",
        "Access-Control-Allow-Methods": "POST,OPTIONS",
      },
      body: "",
    };
  }

  if (event.httpMethod !== "POST") {
    return json(405, { error: "method_not_allowed" });
  }

  // Auth: pull the Supabase user from the Bearer token the app sends
  let user;
  try {
    user = await getUserFromAuthHeader(event);
  } catch (e) {
    console.error("[push-subscribe] auth parse error:", e?.message || e);
    return json(401, { error: "unauthorized", detail: "No/invalid Authorization header" });
  }
  if (!user?.id) {
    return json(401, { error: "unauthorized", detail: "No user in token" });
  }

  // Parse body
  let body = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return json(400, { error: "invalid_json", detail: e?.message || String(e) });
  }

  const endpoint = body?.endpoint || "";
  const p256dh = body?.keys?.p256dh || "";
  const auth = body?.keys?.auth || "";
  const platform = body?.platform || "web";
  const topics = Array.isArray(body?.topics) ? body.topics : ["leads", "messages"];

  if (!endpoint || !p256dh || !auth) {
    return json(400, {
      error: "bad_request",
      detail: "Missing endpoint/keys",
      got: { endpoint: !!endpoint, p256dh: !!p256dh, auth: !!auth },
    });
  }

  // Upsert by (user_id, endpoint)
  try {
    const { data, error } = await supabase
      .from("push_subscriptions")
      .upsert(
        {
          user_id: user.id,
          endpoint,
          p256dh,
          auth,
          platform,
          topics,
          created_at: new Date().toISOString(),
        },
        { onConflict: "user_id,endpoint" }
      )
      .select("id")
      .single();

    if (error) {
      console.error("[push-subscribe] db upsert error:", error.message);
      return json(500, { error: "db_insert_error", detail: error.message });
    }

    return json(200, { ok: true, id: data?.id || null });
  } catch (e) {
    console.error("[push-subscribe] unhandled error:", e?.message || e);
    return json(500, { error: "server_error", detail: e?.message || String(e) });
  }
};
