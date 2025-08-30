// netlify/functions/calendly-events.js

// Required env vars (set in Netlify):
// - SUPABASE_URL
// - SUPABASE_SERVICE_ROLE
// - CALENDLY_CLIENT_ID
// - CALENDLY_CLIENT_SECRET

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const CALENDLY_CLIENT_ID = process.env.CALENDLY_CLIENT_ID;
const CALENDLY_CLIENT_SECRET = process.env.CALENDLY_CLIENT_SECRET;

exports.handler = async (event) => {
  try {
    // Basic validation on env
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
      return json(500, { error: "Missing Supabase env vars" });
    }
    if (!CALENDLY_CLIENT_ID || !CALENDLY_CLIENT_SECRET) {
      return json(500, { error: "Missing Calendly env vars" });
    }

    const url = new URL(event.rawUrl);
    const uid = url.searchParams.get("uid");
    const count = Math.max(
      1,
      Math.min(100, Number(url.searchParams.get("count") || 50))
    );
    const DEBUG = url.searchParams.get("debug") === "1";

    if (!uid) return json(400, { error: "Missing uid" });

    // --- 1) Read the latest tokens for this user from Supabase
    const tRes = await fetch(
      `${SUPABASE_URL}/rest/v1/calendly_tokens?user_id=eq.${encodeURIComponent(
        uid
      )}&select=access_token,refresh_token,expires_at`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
        },
      }
    );

    if (!tRes.ok) return json(500, { error: await tRes.text() });
    const [row] = await tRes.json();
    if (!row) return json(404, { error: "No Calendly token for user" });

    let { access_token, refresh_token, expires_at } = row;

    // --- 2) Refresh token if near/at expiry (30s skew)
    const expMs = new Date(expires_at).getTime();
    if (!Number.isNaN(expMs) && expMs < Date.now() + 30_000) {
      const refreshed = await refresh(refresh_token);
      if (!refreshed.ok) return json(401, { error: refreshed.error });
      ({ access_token, refresh_token, expires_at } = refreshed);

      // Persist updated tokens
      await fetch(`${SUPABASE_URL}/rest/v1/calendly_tokens`, {
        method: "POST",
        headers: {
          apikey: SUPABASE_SERVICE_ROLE,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates",
        },
        body: JSON.stringify([
          { user_id: uid, access_token, refresh_token, expires_at },
        ]),
      });
    }

    // --- 3) Get the user's Calendly URI
    const meRes = await fetch("https://api.calendly.com/users/me", {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    const meJson = await meRes.json().catch(() => ({}));
    if (!meRes.ok) {
      return json(
        500,
        DEBUG
          ? { error: "users/me failed", body: meJson }
          : { error: "users/me failed" }
      );
    }
    const userUri = meJson?.resource?.uri;
    if (!userUri) return json(500, { error: "Missing user uri from Calendly" });

    // --- 4) Pull upcoming events
    const qs = new URLSearchParams({
      user: userUri,
      status: "active",
      sort: "start_time:asc",
      min_start_time: new Date().toISOString(),
      count: String(count),
    });

    const evRes = await fetch(
      `https://api.calendly.com/scheduled_events?${qs.toString()}`,
      {
        headers: { Authorization: `Bearer ${access_token}` },
      }
    );
    const evJson = await evRes.json().catch(() => ({}));
    if (!evRes.ok) {
      return json(
        evRes.status,
        DEBUG
          ? { error: "scheduled_events failed", body: evJson }
          : { error: "scheduled_events failed" }
      );
    }

    // Return events payload straight through
    return json(200, evJson);
  } catch (err) {
    return json(500, { error: err.message || String(err) });
  }
};

// --- helpers ---

async function refresh(refresh_token) {
  try {
    const res = await fetch("https://auth.calendly.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token,
        client_id: CALENDLY_CLIENT_ID,
        client_secret: CALENDLY_CLIENT_SECRET,
      }),
    });
    const jn = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: jn.error || res.statusText };

    // Calendly returns created_at/expiry in seconds
    const base = jn.created_at ? Number(jn.created_at) : Math.floor(Date.now() / 1000);
    const exp = base + Number(jn.expires_in || 0) - 30;

    return {
      ok: true,
      access_token: jn.access_token,
      refresh_token: jn.refresh_token || refresh_token,
      expires_at: new Date(exp * 1000).toISOString(),
    };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify(body),
  };
}
