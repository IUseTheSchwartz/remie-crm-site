// netlify/functions/calendly-auth-callback.js

// IMPORTANT: This must match the Redirect URI you configured in the Calendly Dev Console
const REDIRECT_URI =
  "https://remiecrm.com/.netlify/functions/calendly-auth-callback";

// Where to send users after a successful link
const RETURN_AFTER_LINK = "https://remiecrm.com/app/settings?calendly=connected";

// Calendly OAuth endpoints (per their docs)
const CALENDLY_AUTH_BASE = "https://auth.calendly.com";
const TOKEN_URL = `${CALENDLY_AUTH_BASE}/oauth/token`;

// Supabase REST info
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

exports.handler = async (event) => {
  try {
    // Parse query params from Calendly redirect
    const url = new URL(event.rawUrl || `${event.headers["x-forwarded-proto"]}://${event.headers.host}${event.path}${event.rawQuery ? "?" + event.rawQuery : ""}`);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state"); // we pass user_id in `state` from the client

    if (!code) {
      return text(400, "Missing ?code from Calendly.");
    }
    if (!state) {
      return text(400, "Missing ?state (expected user_id).");
    }

    // Exchange authorization code for tokens
    const tokenRes = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: process.env.CALENDLY_CLIENT_ID,
        client_secret: process.env.CALENDLY_CLIENT_SECRET,
      }),
    });

    if (!tokenRes.ok) {
      const errTxt = await tokenRes.text();
      return text(
        400,
        `Token exchange failed: ${errTxt || tokenRes.statusText}`
      );
    }

    const {
      access_token,
      refresh_token,
      expires_in, // seconds
      created_at, // seconds since epoch (Calendly includes this)
      scope, // might be present/empty based on app configuration
      token_type,
    } = await tokenRes.json();

    // Compute an absolute expiry time (ISO). Add a small safety margin.
    const base = created_at ? Number(created_at) : Math.floor(Date.now() / 1000);
    const expiresAtSec = base + Number(expires_in || 0) - 30;
    const expires_at = new Date(expiresAtSec * 1000).toISOString();

    // Upsert into Supabase via REST (no extra deps needed)
    // Ensure calendly_tokens has a UNIQUE constraint on user_id for upsert to work.
    const upsertRes = await fetch(`${SUPABASE_URL}/rest/v1/calendly_tokens`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_SERVICE_ROLE,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify([
        {
          user_id: state, // <-- we passed the Supabase user id in `state`
          access_token,
          refresh_token,
          expires_at,
          scope: scope || null,
          token_type: token_type || "Bearer",
        },
      ]),
    });

    if (!upsertRes.ok) {
      const errTxt = await upsertRes.text();
      return text(
        500,
        `Failed to save tokens in Supabase: ${errTxt || upsertRes.statusText}`
      );
    }

    // Redirect the browser back to Settings
    return {
      statusCode: 302,
      headers: {
        Location: RETURN_AFTER_LINK,
        "Cache-Control": "no-store",
      },
      body: "",
    };
  } catch (err) {
    return text(500, `Unexpected error: ${err.message || String(err)}`);
  }
};

// Helper: plain text response
function text(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
    body,
  };
}
