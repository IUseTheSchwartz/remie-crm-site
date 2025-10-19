// netlify/functions/user-webhook.js
// Purpose: UI <-> DB for per-user webhook (create/read/rotate)
// Auth: expects Authorization: Bearer <Supabase JWT>

const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    },
    body: JSON.stringify(body),
  };
}

function randSecret(len = 40) {
  const bytes = new Uint8Array(len);
  crypto.webcrypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 40);
}
function makeWebhookId() {
  return `wh_u_${crypto.randomUUID().replace(/-/g, "")}`;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, { ok: true });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return json(500, { error: "Server misconfigured: missing Supabase env" });
  }

  try {
    const auth = event.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return json(401, { error: "Missing auth" });

    // Create a client that forwards the user's JWT on every DB request (so RLS sees auth.uid()).
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });

    // Verify user (also ensures token is valid)
    const { data: userRes, error: uerr } = await supabase.auth.getUser();
    if (uerr || !userRes?.user) return json(401, { error: "Invalid token" });
    const user_id = userRes.user.id;

    if (event.httpMethod === "GET") {
      // return existing active webhook or create new
      const { data: rows, error: selErr } = await supabase
        .from("user_inbound_webhooks")
        .select("id, secret, active")
        .eq("user_id", user_id)
        .eq("active", true)
        .limit(1);

      if (selErr) return json(500, { error: `Select failed: ${selErr.message}` });

      if (rows && rows.length) {
        return json(200, { id: rows[0].id, secret: rows[0].secret });
      }

      const id = makeWebhookId();
      const secret = randSecret();
      const { error: insErr } = await supabase
        .from("user_inbound_webhooks")
        .insert([{ id, user_id, secret, active: true }]);

      if (insErr) return json(500, { error: `Insert failed: ${insErr.message}` });

      return json(200, { id, secret });
    }

    if (event.httpMethod === "POST") {
      let body = {};
      try { body = JSON.parse(event.body || "{}"); } catch {}

      if (body.rotate) {
        const newSecret = randSecret();
        const { data, error: updErr } = await supabase
          .from("user_inbound_webhooks")
          .update({ secret: newSecret })
          .eq("user_id", user_id)
          .eq("active", true)
          .select("id, secret")
          .limit(1);

        if (updErr) return json(500, { error: `Update failed: ${updErr.message}` });

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
