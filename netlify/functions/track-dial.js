// netlify/functions/track-dial.js
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
    const db = getServiceClient();

    // ---- Auth: header bearer OR body.jwt
    let user = await getUserFromRequest(event);
    if (!user) {
      if (event.httpMethod !== "GET") {
        try {
          const body = JSON.parse(event.body || "{}");
          if (body?.jwt) {
            // decode via supabase to get user
            const { data, error } = await db.auth.getUser(body.jwt);
            if (!error) user = data?.user || null;
          }
        } catch {}
      }
    }
    if (!user?.id) {
      if (event.httpMethod === "GET") {
        // return zero (don’t throw) so the UI can still render
        return json(200, { ok: true, count: 0, unauthenticated: true });
      }
      return json(401, { ok: false, error: "unauthorized" });
    }

    if (event.httpMethod === "GET") {
      // return today’s count for this user
      const { data, error } = await db
        .from("dial_events")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user.id)
        .eq("day", new Date().toISOString().slice(0, 10)); // YYYY-MM-DD

      if (error) return json(500, { ok: false, error: error.message });
      return json(200, { ok: true, count: data.length ? data.length : 0 });
    }

    if (event.httpMethod === "POST") {
      let body = {};
      try { body = JSON.parse(event.body || "{}"); } catch {}
      const { lead_id, phone, method } = body;

      if (!method || !["tel", "facetime"].includes(method)) {
        return json(400, { ok: false, error: "invalid_method" });
      }

      const ins = await db.from("dial_events").insert([{
        user_id: user.id,
        lead_id: lead_id || null,
        phone: phone || null,
        method,
      }]).select("id").single();

      if (ins.error) return json(500, { ok: false, error: ins.error.message });

      // Return updated count for today (nice for optimistic UI sanity)
      const { data, error } = await db
        .from("dial_events")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user.id)
        .eq("day", new Date().toISOString().slice(0, 10));

      if (error) return json(200, { ok: true, id: ins.data.id, count: null });

      return json(200, { ok: true, id: ins.data.id, count: data.length ? data.length : 0 });
    }

    return json(405, { ok: false, error: "method_not_allowed" });
  } catch (e) {
    console.error("[track-dial] unhandled:", e);
    return json(500, { ok: false, error: "server_error" });
  }
};
