// netlify/functions/dial-get.js
const { getServiceClient, getUserFromRequest } = require("./_supabase");

function json(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "GET") return json(405, { error: "method_not_allowed" });

    const tz = (event.queryStringParameters?.tz || "").trim();
    if (!tz) return json(400, { error: "missing_tz" });

    const user = await getUserFromRequest(event);
    if (!user?.id) return json(401, { error: "unauthorized" });

    const svc = getServiceClient();
    const { data, error } = await svc
      .rpc("get_dial_count", { p_user_id: user.id, p_tz: tz });

    if (error) return json(500, { error: error.message });
    return json(200, { ok: true, count: data });
  } catch (e) {
    return json(500, { error: e.message || "server_error" });
  }
};
