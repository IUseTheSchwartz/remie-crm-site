// netlify/functions/user-webhook.js
// Purpose: UI <-> DB for per-user webhook (create/read/rotate)
// Auth: expects Authorization: Bearer <Supabase JWT> from supabase.auth.getSession()

const { createClient } = require("@supabase/supabase-js");

const supabaseAnon = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

function json(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

function randSecret(len = 40) {
  const bytes = new Uint8Array(len);
  require("crypto").webcrypto.getRandomValues(bytes);
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, 40);
}

function makeWebhookId() {
  return `wh_u_${require("crypto").randomUUID().replace(/-/g, "")}`;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, { ok: true });

  try {
    const auth = event.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return json(401, { error: "Missing auth" });

    const { data: userRes, error: userErr } = await supabaseAnon.auth.getUser(token);
    if (userErr || !userRes?.user) return json(401, { error: "Invalid token" });
    const user_id = userRes.user.id;

    if (event.httpMethod === "GET") {
      // fetch existing active webhook or create a new one
      const { data: rows, error: selErr } = await supabaseAnon
        .from("user_inbound_webhooks")
        .select("id, secret, active")
        .eq("user_id", user_id)
        .eq("active", true)
        .limit(1);

      if (selErr) return json(400, { error: selErr.message });

      if (rows && rows.length) {
        return json(200, { id: rows[0].id, secret: rows[0].secret });
      }

      const id = makeWebhookId();
      const secret = randSecret();

      const { error: insErr } = await supabaseAnon
        .from("user_inbound_webhooks")
        .insert([{ id, user_id, secret, active: true }]);

      if (insErr) return json(400, { error: insErr.message });

      return json(200, { id, secret });
    }

    if (event.httpMethod === "POST") {
      let body = {};
      try { body = JSON.parse(event.body || "{}"); } catch {}
      if (body.rotate) {
        const newSecret = randSecret();
        const { data, error: upErr } = await supabaseAnon
          .from("user_inbound_webhooks")
          .update({ secret: newSecret })
          .eq("user_id", user_id)
          .eq("active", true)
          .select("id, secret")
          .limit(1);

        if (upErr) return json(400, { error: upErr.message });
        const row = data?.[0];
        if (!row) return json(404, { error: "No active webhook" });
        return json(200, { id: row.id, secret: row.secret });
      }
      return json(400, { error: "Unsupported action" });
    }

    return json(405, { error: "Method not allowed" });
  } catch (e) {
    console.error("user-webhook error:", e);
    return json(500, { error: "Server error" });
  }
};