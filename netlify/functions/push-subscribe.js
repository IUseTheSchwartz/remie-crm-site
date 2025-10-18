// File: netlify/functions/push-subscribe.js
const { getServiceClient, getUserFromRequest } = require("./_supabase");

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

    const authHeader =
      event.headers.authorization ||
      event.headers.Authorization ||
      event.headers.AUTHORIZATION ||
      "";

    const hasBearer = typeof authHeader === "string" && authHeader.startsWith("Bearer ");
    console.log("[push-subscribe] method:", event.httpMethod, "hasBearer:", !!hasBearer);

    let user = null;

    // Parse body first so we can access fallback fields
    let body = {};
    try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { error: "invalid_json" }); }

    // 1) Try normal header/JWT path
    if (hasBearer) {
      user = await getUserFromRequest(event);
    }

    // 2) Fallback: JWT passed in body
    if (!user && body?.jwt) {
      try {
        const fakeEvent = { headers: { authorization: `Bearer ${body.jwt}` } };
        user = await getUserFromRequest(fakeEvent);
        console.log("[push-subscribe] used body.jwt fallback:", !!user);
      } catch (e) {
        console.warn("[push-subscribe] jwt fallback error:", e?.message || e);
      }
    }

    // 3) Final fallback: accept a user_id and verify it with Admin API
    if (!user && body?.user_id) {
      try {
        const svc = getServiceClient();
        const found = await svc.auth.admin.getUserById(body.user_id);
        if (found?.data?.user?.id) {
          user = { id: found.data.user.id };
          console.log("[push-subscribe] verified user_id via admin API");
        }
      } catch (e) {
        console.warn("[push-subscribe] admin verify failed:", e?.message || e);
      }
    }

    if (!user) {
      console.error("[push-subscribe] unauthorized: no user from token");
      return json(401, { error: "unauthorized" });
    }

    const { endpoint, keys, platform, topics } = body || {};
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return json(400, { error: "missing_subscription" });
    }

    const supabase = getServiceClient();

    // Upsert by user_id + endpoint
    const { data: existing, error: selErr } = await supabase
      .from("push_subscriptions")
      .select("id")
      .eq("user_id", user.id)
      .eq("endpoint", endpoint)
      .limit(1);

    if (selErr) {
      console.error("[push-subscribe] select error:", selErr?.message || selErr);
      return json(500, { error: "db_select_error" });
    }

    if (existing && existing.length) {
      const { error: updErr } = await supabase
        .from("push_subscriptions")
        .update({
          p256dh: keys.p256dh,
          auth: keys.auth,
          platform: platform || null,
          topics: Array.isArray(topics) ? topics : null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing[0].id);

      if (updErr) {
        console.error("[push-subscribe] update error:", updErr?.message || updErr);
        return json(500, { error: "db_update_error" });
      }
      return json(200, { ok: true, updated: true });
    }

    const { error: insErr } = await supabase
      .from("push_subscriptions")
      .insert([{
        user_id: user.id,
        endpoint,
        p256dh: keys.p256dh,
        auth: keys.auth,
        platform: platform || null,
        topics: Array.isArray(topics) ? topics : null,
      }]);

    if (insErr) {
      console.error("[push-subscribe] insert error:", insErr?.message || insErr);
      return json(500, { error: "db_insert_error" });
    }

    return json(200, { ok: true, created: true });
  } catch (e) {
    console.error("[push-subscribe] unhandled:", e?.message || e);
    return json(500, { error: "server_error" });
  }
};
