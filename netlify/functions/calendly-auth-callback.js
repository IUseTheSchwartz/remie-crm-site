// netlify/functions/calendly-auth-callback.js
// Uses Node's global `fetch` (no node-fetch dependency)

const { createClient } = require("@supabase/supabase-js");

// Env vars you must have in Netlify:
//  - SITE_URL  (e.g. https://remiecrm.com)
//  - SUPABASE_URL
//  - SUPABASE_SERVICE_ROLE
//  - CALENDLY_CLIENT_ID
//  - CALENDLY_CLIENT_SECRET
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE
);

exports.handler = async (event) => {
  try {
    const url = new URL(event.rawUrl);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state"); // we pass user_id here from the client (optional but recommended)

    if (!code) {
      return { statusCode: 400, body: "Missing ?code param from Calendly" };
    }

    // Exchange code for tokens
    const tokenRes = await fetch("https://auth.calendly.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: `${process.env.SITE_URL}/.netlify/functions/calendly-auth-callback`,
        client_id: process.env.CALENDLY_CLIENT_ID,
        client_secret: process.env.CALENDLY_CLIENT_SECRET,
      }),
    });

    const tokenJson = await tokenRes.json();
    if (!tokenRes.ok || !tokenJson.access_token) {
      return {
        statusCode: 400,
        body: `Token exchange failed: ${JSON.stringify(tokenJson)}`,
      };
    }

    const now = Date.now();
    const expiresAt = new Date(now + tokenJson.expires_in * 1000).toISOString();

    // You should tie this to the current user. We pass user_id in ?state= from the client.
    const user_id = state || null;

    if (!user_id) {
      // If you didn't pass state, you won't know who to save the tokens for.
      // You can still redirect, but tokens won't be saved to a user row.
      return {
        statusCode: 302,
        headers: {
          Location: `${process.env.SITE_URL}/app/calendar?connected=0&reason=missing_state`,
        },
        body: "",
      };
    }

    // Save / upsert tokens
    const { error } = await supabase.from("calendly_tokens").upsert(
      {
        user_id,
        access_token: tokenJson.access_token,
        refresh_token: tokenJson.refresh_token || null,
        token_type: tokenJson.token_type || "Bearer",
        expires_at: expiresAt,
      },
      { onConflict: "user_id" }
    );

    if (error) {
      return { statusCode: 500, body: `Supabase error: ${error.message}` };
    }

    // Bounce back to the app
    return {
      statusCode: 302,
      headers: { Location: `${process.env.SITE_URL}/app/calendar?connected=1` },
      body: "",
    };
  } catch (err) {
    return { statusCode: 500, body: err.stack || String(err) };
  }
};
