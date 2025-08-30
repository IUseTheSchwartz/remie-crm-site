// File: netlify/functions/calendly-auth-callback.js
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

export const handler = async (event) => {
  try {
    const url = new URL(event.rawUrl);
    const code = url.searchParams.get("code");
    if (!code) {
      return {
        statusCode: 400,
        body: "Missing ?code",
      };
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
    const CALENDLY_CLIENT_ID = process.env.CALENDLY_CLIENT_ID;
    const CALENDLY_CLIENT_SECRET = process.env.CALENDLY_CLIENT_SECRET;
    const SITE_URL = process.env.SITE_URL || url.origin;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
      return { statusCode: 500, body: "Missing Supabase env vars" };
    }
    if (!CALENDLY_CLIENT_ID || !CALENDLY_CLIENT_SECRET) {
      return { statusCode: 500, body: "Missing Calendly env vars" };
    }

    // Get the current user via a Supabase cookie (Netlify + Supabase)
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);
    const { data: auth } = await supabase.auth.getUser();
    const uid = auth?.user?.id;
    if (!uid) {
      // If your auth cookie isn't available in the function runtime,
      // you can pass user_id in state or set up a signed redirect.
      return { statusCode: 401, body: "Not authenticated." };
    }

    const redirectUri = `${SITE_URL}/.netlify/functions/calendly-auth-callback`;

    // Exchange code for tokens
    const tokenResp = await fetch("https://auth.calendly.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: CALENDLY_CLIENT_ID,
        client_secret: CALENDLY_CLIENT_SECRET,
      }),
    });

    if (!tokenResp.ok) {
      const txt = await tokenResp.text();
      return { statusCode: 500, body: `Token exchange failed: ${txt}` };
    }

    const tokens = await tokenResp.json();
    const { access_token, refresh_token, expires_in, token_type } = tokens;

    // Store in Supabase
    const { error } = await supabase.from("calendly_tokens").upsert(
      {
        user_id: uid,
        access_token,
        refresh_token,
        token_type: token_type || "Bearer",
        expires_at: new Date(Date.now() + (expires_in || 3600) * 1000).toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" }
    );
    if (error) {
      return { statusCode: 500, body: `DB error: ${error.message}` };
    }

    // Send user back to settings page
    return {
      statusCode: 302,
      headers: { Location: `${SITE_URL}/app/settings?calendly=connected` },
      body: "",
    };
  } catch (err) {
    return { statusCode: 500, body: err.message || "Unexpected error" };
  }
};
