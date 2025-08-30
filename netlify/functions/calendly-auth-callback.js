// Netlify Function: calendly-auth-callback.js
// - Exchanges Calendly OAuth "code" for access/refresh tokens
// - Resolves the user (via ?state=<user_id> OR Calendly email lookup)
// - Upserts into public.calendly_tokens (user_id PK)
// - Redirects back to /app/calendar with success/failure flag

import { createClient } from "@supabase/supabase-js";

// Calendly endpoints
const AUTH_BASE = "https://auth.calendly.com";
const API_BASE = "https://api.calendly.com";

// Build the redirect URI exactly as Calendly expects (domain must match)
function buildRedirectUri(event) {
  const host = event.headers["x-forwarded-host"] || event.headers.host;
  const proto =
    event.headers["x-forwarded-proto"] ||
    (host && host.includes("localhost") ? "http" : "https");
  return `${proto}://${host}/.netlify/functions/calendly-auth-callback`;
}

export async function handler(event) {
  try {
    const params = new URLSearchParams(event.rawQuery || "");
    const code = params.get("code");
    const state = params.get("state") || ""; // we try to use this as user_id

    const redirectUri = buildRedirectUri(event);

    const {
      SUPABASE_URL,
      SUPABASE_SERVICE_ROLE,
      CALENDLY_CLIENT_ID,
      CALENDLY_CLIENT_SECRET,
    } = process.env;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
      return text(500, "Missing Supabase env (SUPABASE_URL / SUPABASE_SERVICE_ROLE).");
    }
    if (!CALENDLY_CLIENT_ID || !CALENDLY_CLIENT_SECRET) {
      return text(500, "Missing Calendly env (CALENDLY_CLIENT_ID / CALENDLY_CLIENT_SECRET).");
    }
    if (!code) {
      return text(400, "Missing 'code' query param.");
    }

    // 1) Exchange authorization code for tokens
    const tokenRes = await fetch(`${AUTH_BASE}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CALENDLY_CLIENT_ID,
        client_secret: CALENDLY_CLIENT_SECRET,
        redirect_uri: redirectUri,
        code,
      }).toString(),
    });

    const tokenJson = await tokenRes.json();
    if (!tokenRes.ok) {
      // Helpful error for invalid_grant / redirect mismatches
      return text(
        400,
        `Token exchange failed: ${JSON.stringify(tokenJson)}`
      );
    }

    const {
      access_token,
      refresh_token,
      expires_in, // seconds
      scope: tokenScope,
    } = tokenJson;

    // 2) Determine which CRM user this Calendly account belongs to
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, {
      auth: { persistSession: false },
    });

    let userIdFromState = state && state.trim().length > 0 ? state.trim() : null;

    // If state isn't present (or you want extra safety), fetch Calendly user email
    let userId = userIdFromState;
    if (!userId) {
      const meRes = await fetch(`${API_BASE}/users/me`, {
        headers: { Authorization: `Bearer ${access_token}` },
      });
      const meJson = await meRes.json();
      if (!meRes.ok) {
        return text(
          400,
          `Failed to fetch Calendly user: ${JSON.stringify(meJson)}`
        );
      }
      const email = meJson?.resource?.email || null;
      if (!email) return text(400, "Could not determine Calendly user email.");

      // Look up your Supabase auth user by email (service role can read auth.users)
      const { data: authUsers, error: auErr } = await supabase
        .from("auth.users")
        .select("id,email")
        .eq("email", email)
        .limit(1);

      if (auErr) return text(500, `auth.users query error: ${auErr.message}`);
      if (!authUsers || authUsers.length === 0) {
        return text(400, `No CRM user found for Calendly email: ${email}`);
      }
      userId = authUsers[0].id;
    }

    // 3) Upsert token in your public.calendly_tokens table
    const expiresAt = new Date(Date.now() + (expires_in || 3600) * 1000)
      .toISOString();

    const { error: upErr } = await supabase
      .from("calendly_tokens")
      .upsert(
        {
          user_id: userId,
          access_token,
          refresh_token,
          expires_at: expiresAt,
          scope: tokenScope || null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" }
      );

    if (upErr) return text(500, `DB upsert error: ${upErr.message}`);

    // 4) Redirect back to your app's calendar page
    const uiOrigin =
      (event.headers["x-forwarded-proto"] || "https") +
      "://" +
      (event.headers["x-forwarded-host"] || event.headers.host);

    return {
      statusCode: 302,
      headers: {
        Location: `${uiOrigin}/app/calendar?connected=1`,
        "Cache-Control": "no-store",
      },
      body: "",
    };
  } catch (err) {
    return text(500, `Unhandled error: ${err.message || String(err)}`);
  }
}

// Small helper to return plain text responses
function text(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
    body,
  };
}
