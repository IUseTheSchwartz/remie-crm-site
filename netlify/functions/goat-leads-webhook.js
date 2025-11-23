// File: netlify/functions/user-goat-webhook.js
// Per-user Goat Leads webhook URL generator.
// Frontend calls this to get/create a URL like:
//   https://remiecrm.com/.netlify/functions/goat-leads-inbound?token=XYZ

const { getServiceClient } = require("./_supabase");
const crypto = require("crypto");

function json(body, statusCode = 200) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function getBaseUrl() {
  const base =
    process.env.SITE_URL ||
    process.env.URL ||
    process.env.DEPLOY_PRIME_URL ||
    "https://remiecrm.com";
  return String(base).replace(/\/+$/, "");
}

function makeToken() {
  // simple random token
  return crypto.randomBytes(18).toString("base64url");
}

exports.handler = async (event) => {
  const db = getServiceClient();

  // We’ll accept user_id via query/body from the frontend
  let user_id =
    (event.queryStringParameters && event.queryStringParameters.user_id) ||
    null;

  try {
    if (!user_id && event.httpMethod === "POST") {
      try {
        const body = JSON.parse(event.body || "{}");
        if (body.user_id) user_id = String(body.user_id);
      } catch (_) {}
    }

    if (!user_id) {
      return json(
        { error: "missing_user_id", hint: "frontend must pass user_id" },
        400
      );
    }

    // Ensure agent_profiles row exists
    let { data: profile, error } = await db
      .from("agent_profiles")
      .select("user_id, goat_webhook_token")
      .eq("user_id", user_id)
      .maybeSingle();
    if (error) throw error;

    if (!profile) {
      const ins = await db
        .from("agent_profiles")
        .insert([{ user_id, goat_webhook_token: null }])
        .select("user_id, goat_webhook_token")
        .maybeSingle();
      if (ins.error) throw ins.error;
      profile = ins.data;
    }

    const method = event.httpMethod.toUpperCase();
    let action = "load";

    if (method === "POST") {
      try {
        const body = JSON.parse(event.body || "{}");
        if (body.action) action = String(body.action);
      } catch (_) {}
    }

    let token = profile.goat_webhook_token;

    if (method === "POST" && (action === "create" || action === "regenerate")) {
      token = makeToken();
      const upd = await db
        .from("agent_profiles")
        .update({ goat_webhook_token: token })
        .eq("user_id", user_id)
        .select("goat_webhook_token")
        .maybeSingle();
      if (upd.error) throw upd.error;
      token = upd.data.goat_webhook_token;
    }

    // If GET and no token yet, auto-create one
    if (method === "GET" && !token) {
      token = makeToken();
      const upd = await db
        .from("agent_profiles")
        .update({ goat_webhook_token: token })
        .eq("user_id", user_id)
        .select("goat_webhook_token")
        .maybeSingle();
      if (upd.error) throw upd.error;
      token = upd.data.goat_webhook_token;
    }

    if (!token) {
      return json({ ok: false, error: "no_token_generated" }, 500);
    }

    const url = `${getBaseUrl()}/.netlify/functions/goat-leads-inbound?token=${encodeURIComponent(
      token
    )}`;

    return json({ ok: true, url, token });
  } catch (e) {
    console.error("[user-goat-webhook] error:", e);
    return json(
      {
        ok: false,
        error: e.message || String(e),
      },
      500
    );
  }
};
