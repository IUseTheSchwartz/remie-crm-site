// File: netlify/functions/calendly-auth-callback.js
const { createClient } = require("@supabase/supabase-js");

// Calendly token endpoint (per docs)
const TOKEN_URL = "https://auth.calendly.com/oauth/token";

exports.handler = async (event) => {
  try {
    const params = new URLSearchParams(event.rawQuery || "");
    const code = params.get("code");
    const stateUserId = params.get("state"); // we sent user_id as "state" from the client

    if (!code) {
      return text(400, "Missing ?code in callback.");
    }
    if (!stateUserId) {
      return text(400, "Missing ?state (user id).");
    }

    const {
      CALENDLY_CLIENT_ID,
      CALENDLY_CLIENT_SECRET,
      SITE_URL,
      SUPABASE_URL,
      SUPABASE_SERVICE_ROLE,
    } = process.env;

    if (!CALENDLY_CLIENT_ID || !CALENDLY_CLIENT_SECRET) {
      return text(500, "Server missing Calendly client credentials.");
    }
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
      return text(500, "Server missing Supabase service role env.");
    }

    const redirectUri = `${(SITE_URL || "").replace(/\/$/, "")}/.netlify/functions/calendly-auth-callback`;

    // Build basic auth header: base64(client_id:client_secret)
    const basic = Buffer.from(
      `${CALENDLY_CLIENT_ID}:${CALENDLY_CLIENT_SECRET}`,
      "utf8"
    ).toString("base64");

    // Exchange code for tokens
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    });

    const tokenRes = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });

    const tokenJson = await tokenRes.json();

    if (!tokenRes.ok) {
      console.error("Calendly token exchange failed:", tokenJson);
      return text(
        400,
        `Token exchange failed: ${JSON.stringify(tokenJson)}`
      );
    }

    const {
      access_token,
      refresh_token,
      token_type,
      expires_in,
      scope,
      created_at,
      owner, // Calendly includes an owner resource sometimes
    } = tokenJson;

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

    // Upsert into your table (see SQL below)
    const { error: upsertErr } = await supabase
      .from("calendly_tokens")
      .upsert(
        {
          user_id: stateUserId,
          access_token,
          refresh_token,
          token_type,
          expires_in,
          scope,
          created_at: created_at ? new Date(created_at * 1000).toISOString() : null,
          connected_at: new Date().toISOString(),
        },
        { onConflict: "user_id" }
      );

    if (upsertErr) {
      console.error("Supabase upsert error:", upsertErr);
      return text(500, "Saved tokens failed.");
    }

    // Redirect back to your app
    const back = `${(SITE_URL || "").replace(/\/$/, "")}/app/calendar?connected=1`;
    return {
      statusCode: 302,
      headers: { Location: back },
      body: "",
    };
  } catch (err) {
    console.error(err);
    return text(500, "Unexpected server error.");
  }
};

function text(status, msg) {
  return { statusCode: status, headers: { "Content-Type": "text/plain" }, body: msg };
}
