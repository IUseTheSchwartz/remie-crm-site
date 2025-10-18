// netlify/functions/dial-increment.js
const { getServiceClient, getUserFromRequest } = require("./_supabase");

function json(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return json(405, { error: "method_not_allowed" });

    // Parse body (tz is required)
    let body = {};
    try { body = JSON.parse(event.body || "{}"); } catch {}
    const tz = (body.tz || "").trim();
    if (!tz) return json(400, { error: "missing_tz" });

    // Auth: accept Bearer header or { jwt } in body (works in iOS PWA)
    const user = await getUserFromRequest(event) || (async () => {
      const jwt = body.jwt || "";
      if (!jwt) return null;
      const svc = getServiceClient();
      const { data, error } = await svc.auth.getUser(jwt);
      if (error) return null;
      return data?.user || null;
    })();

    if (!user?.id) return json(401, { error: "unauthorized" });

    const svc = getServiceClient();
    const { data, error } = await svc
      .rpc("increment_dial_count", { p_user_id: user.id, p_tz: tz });

    if (error) return json(500, { error: error.message });
    return json(200, { ok: true, count: data });
  } catch (e) {
    return json(500, { error: e.message || "server_error" });
  }
};
