// netlify/functions/push-subscribe.js
const { getServiceClient, getUserFromAuthHeader } = require("./_supabase");

function j(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return j(405, { ok: false, error: "method_not_allowed" });

  try {
    const user = await getUserFromAuthHeader(event);
    if (!user?.id) return j(401, { ok: false, error: "unauthorized" });

    let body = {};
    try { body = JSON.parse(event.body || "{}"); }
    catch { return j(400, { ok: false, error: "bad_json" }); }

    const endpoint = String(body.endpoint || "");
    const keys = body.keys || {};
    const platform = String(body.platform || "web");
    const topics = Array.isArray(body.topics) ? body.topics : [];
    const user_agent = event.headers["user-agent"] || event.headers["User-Agent"] || "";

    if (!endpoint || !keys.p256dh || !keys.auth) {
      return j(400, { ok: false, error: "missing_fields", got: { endpoint: !!endpoint, p256dh: !!keys.p256dh, auth: !!keys.auth } });
    }

    const supabase = getServiceClient();

    // Try to update by endpoint, else insert
    const { data: existing, error: selErr } = await supabase
      .from("push_subscriptions")
      .select("id")
      .eq("endpoint", endpoint)
      .limit(1);

    if (selErr) {
      console.error("[push-subscribe] select error:", selErr);
      return j(500, { ok: false, error: "db_select_error", detail: selErr.message });
    }

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

      if (updErr) {
        console.error("[push-subscribe] update error:", updErr);
        return j(500, { ok: false, error: "db_update_error", detail: updErr.message });
      }
      return j(200, { ok: true, updated: 1 });
    }

    const { error: insErr } = await supabase.from("push_subscriptions").insert([{
      user_id: user.id,
      endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
      platform,
      topics,
      is_active: true,
      user_agent,
    }]);

    if (insErr) {
      console.error("[push-subscribe] insert error:", insErr);
      return j(500, { ok: false, error: "db_insert_error", detail: insErr.message });
    }

    return j(200, { ok: true, inserted: 1 });
  } catch (e) {
    console.error("[push-subscribe] unhandled:", e);
    return j(500, { ok: false, error: "server_error", detail: e.message || String(e) });
  }
};
