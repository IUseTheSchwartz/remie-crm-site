// netlify/functions/push-subscribe.js
const { getServiceClient, getUserFromAuthHeader } = require("./_supabase");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "method_not_allowed" };
  }

  try {
    const user = await getUserFromAuthHeader(event);
    if (!user?.id) {
      return {
        statusCode: 401,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ok: false, error: "unauthorized" }),
      };
    }

    const body = JSON.parse(event.body || "{}");
    const endpoint = String(body.endpoint || "");
    const keys = body.keys || {};
    const platform = String(body.platform || "web");
    const topics = Array.isArray(body.topics) ? body.topics : [];
    const user_agent = event.headers["user-agent"] || event.headers["User-Agent"] || "";

    if (!endpoint || !keys.p256dh || !keys.auth) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ok: false, error: "missing_fields" }),
      };
    }

    const supabase = getServiceClient();

    // Try update by endpoint; if none updated, insert new
    const { data: existing, error: selErr } = await supabase
      .from("push_subscriptions")
      .select("id")
      .eq("endpoint", endpoint)
      .limit(1);

    if (selErr) throw selErr;

    if (existing && existing.length) {
      const id = existing[0].id;
      const { error: updErr } = await supabase
        .from("push_subscriptions")
        .update({
          user_id: user.id,
          p256dh: keys.p256dh,
          auth: keys.auth,
          platform,
          topics,
          is_active: true,
          user_agent,
        })
        .eq("id", id);
      if (updErr) throw updErr;
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ok: true, updated: 1 }),
      };
    } else {
      const { error: insErr } = await supabase.from("push_subscriptions").insert([
        {
          user_id: user.id,
          endpoint,
          p256dh: keys.p256dh,
          auth: keys.auth,
          platform,
          topics,
          is_active: true,
          user_agent,
        },
      ]);
      if (insErr) throw insErr;
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ok: true, inserted: 1 }),
      };
    }
  } catch (e) {
    console.error("[push-subscribe] error:", e);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: false, error: e.message || String(e) }),
    };
  }
};
