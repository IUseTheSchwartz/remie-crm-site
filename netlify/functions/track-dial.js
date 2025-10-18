// File: netlify/functions/track-dial.js
// GET  -> returns today's dial count for the authed user
// POST -> records a dial event and returns updated count

const { getServiceClient, getUserFromRequest } = require("./_supabase");

function json(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function todayRangeUTC() {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

exports.handler = async (event) => {
  const db = getServiceClient();

  // Identify the user (Authorization: Bearer … OR body.jwt fallback)
  let user = await getUserFromRequest(event);
  if (!user && event.httpMethod === "POST") {
    try {
      const body = JSON.parse(event.body || "{}");
      if (body.jwt && typeof body.jwt === "string") {
        // Validate JWT via service client
        const { data, error } = await db.auth.getUser(body.jwt);
        if (!error) user = data?.user || null;
      }
    } catch {}
  }
  if (!user) return json(401, { error: "unauthorized" });

  const uid = user.id;
  const { start, end } = todayRangeUTC();

  if (event.httpMethod === "GET") {
    // count today's dials
    const { data, error } = await db
      .from("dial_events")
      .select("id", { count: "exact", head: true })
      .eq("user_id", uid)
      .gte("created_at", start)
      .lt("created_at", end);

    if (error) return json(500, { error: error.message });
    return json(200, { ok: true, count: data?.length ?? 0 });
  }

  if (event.httpMethod === "POST") {
    let body = {};
    try { body = JSON.parse(event.body || "{}"); } catch {}

    const row = {
      user_id: uid,
      lead_id: body.lead_id ?? null,
      phone: body.phone ?? null,
      method: body.method === "facetime" ? "facetime" : "tel",
      created_at: new Date().toISOString(),
    };

    const ins = await db.from("dial_events").insert([row]);
    if (ins.error) return json(500, { error: ins.error.message });

    // return fresh count
    const { data, error } = await db
      .from("dial_events")
      .select("id", { count: "exact", head: true })
      .eq("user_id", uid)
      .gte("created_at", start)
      .lt("created_at", end);

    if (error) return json(500, { error: error.message });
    return json(200, { ok: true, count: data?.length ?? 0 });
  }

  return json(405, { error: "method_not_allowed" });
};
