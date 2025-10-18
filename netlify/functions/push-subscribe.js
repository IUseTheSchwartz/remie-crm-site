// netlify/functions/push-subscribe.js
// Stores a browser push subscription for the authenticated user.
// Accepts auth in Authorization header OR body fallback (jwt + user_id).

const { getServiceClient } = require("./_supabase");

function json(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  };
}

async function getUserFromAuth({ headers, body }) {
  // 1) Try Authorization: Bearer <jwt>
  const authHeader =
    headers.authorization || headers.Authorization || headers.AUTHORIZATION || "";
  const bearerJwt =
    typeof authHeader === "string" && authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : null;

  // 2) Try fallback jwt + user_id from body
  const bodyJwt = body?.jwt || null;
  const bodyUid = body?.user_id || null;

  const hasBearer = !!bearerJwt;
  const hasBodyJwt = !!bodyJwt;
  const hasBodyUid = !!bodyUid;

  console.log(
    "[push-subscribe] auth flags",
    JSON.stringify({ hasBearer, hasBodyJwt, hasBodyUid })
  );

  const jwt = bearerJwt || bodyJwt || null;
  if (!jwt) return { user: null, why: "no_jwt" };

  try {
    const svc = getServiceClient();
    const { data, error } = await svc.auth.getUser(jwt);
    if (error || !data?.user?.id) {
      console.warn("[push-subscribe] svc.auth.getUser failed:", error?.message || "no user");
      return { user: null, why: "bad_jwt" };
    }
    // Optional: if bodyUid provided, ensure it matches the JWT user
    if (bodyUid && bodyUid !== data.user.id) {
      console.warn("[push-subscribe] bodyUid mismatch", { bodyUid, jwtUid: data.user.id });
    }
    return { user: data.user, why: null };
  } catch (e) {
    console.error("[push-subscribe] auth exception:", e?.message || e);
    return { user: null, why: "exception" };
  }
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return json(405, { error: "method_not_allowed" });

    const headers = event.headers || {};
    let body = {};
    try { body = JSON.parse(event.body || "{}"); } catch {}

    const { user, why } = await getUserFromAuth({ headers, body });
    if (!user?.id) {
      console.error("[push-subscribe] unauthorized:", why);
      return json(401, { error: "unauthorized", why });
    }

    const { endpoint, keys, platform, topics } = body || {};
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return json(400, { error: "invalid_subscription" });
    }

    const supabase = getServiceClient();

    // Upsert by unique (user_id, endpoint)
    const payload = {
      user_id: user.id,
      endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
      platform: platform || "web",
      topics: Array.isArray(topics) ? topics : ["general"],
    };

    // Check existing
    const { data: existing, error: selErr } = await supabase
      .from("push_subscriptions")
      .select("id")
      .eq("user_id", user.id)
      .eq("endpoint", endpoint)
      .limit(1);

    if (selErr) {
      console.error("[push-subscribe] select error:", selErr.message);
      return json(500, { error: "db_select_error" });
    }

    if (existing && existing.length) {
      const { error: updErr } = await supabase
        .from("push_subscriptions")
        .update(payload)
        .eq("id", existing[0].id);
      if (updErr) {
        console.error("[push-subscribe] update error:", updErr.message);
        return json(500, { error: "db_update_error" });
      }
      console.log("[push-subscribe] updated sub id", existing[0].id);
      return json(200, { ok: true, updated: 1 });
    }

    const { error: insErr } = await supabase.from("push_subscriptions").insert([payload]);
    if (insErr) {
      console.error("[push-subscribe] insert error:", insErr.message);
      return json(500, { error: "db_insert_error" });
    }

    console.log("[push-subscribe] inserted new sub for", user.id);
    return json(200, { ok: true, inserted: 1 });
  } catch (e) {
    console.error("[push-subscribe] unhandled:", e?.message || e);
    return json(500, { error: "server_error" });
  }
};
