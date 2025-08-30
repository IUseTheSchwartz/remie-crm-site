// netlify/functions/calendly-user.js
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const CAL_CLIENT_ID = process.env.CALENDLY_CLIENT_ID;
const CAL_CLIENT_SECRET = process.env.CALENDLY_CLIENT_SECRET;

exports.handler = async (event) => {
  try {
    const url = new URL(event.rawUrl);
    const uid = url.searchParams.get("uid");
    const DEBUG = url.searchParams.get("debug") === "1";
    if (!uid) return json(400, { error: "Missing uid" });

    // read tokens
    const tRes = await fetch(
      `${SUPABASE_URL}/rest/v1/calendly_tokens?user_id=eq.${encodeURIComponent(uid)}&select=access_token,refresh_token,expires_at`,
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

    // refresh if expired
    const expMs = new Date(expires_at).getTime();
    if (!Number.isNaN(expMs) && expMs < Date.now() + 30_000) {
      const refreshed = await refresh(refresh_token);
      if (!refreshed.ok) return json(401, { error: refreshed.error });
      ({ access_token, refresh_token, expires_at } = refreshed);

      // persist new tokens
      await fetch(`${SUPABASE_URL}/rest/v1/calendly_tokens`, {
        method: "POST",
        headers: {
          apikey: SUPABASE_SERVICE_ROLE,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates",
        },
        body: JSON.stringify([{ user_id: uid, access_token, refresh_token, expires_at }]),
      });
    }

    const meRes = await fetch("https://api.calendly.com/users/me", {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    const meJson = await meRes.json().catch(() => ({}));
    if (!meRes.ok) return json(500, DEBUG ? { error: "users/me failed", body: meJson } : { error: "users/me failed" });

    return json(200, meJson);
  } catch (e) {
    return json(500, { error: e.message || String(e) });
  }

  async function refresh(refresh_token) {
    try {
      const res = await fetch("https://auth.calendly.com/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token,
          client_id: CAL_CLIENT_ID,
          client_secret: CAL_CLIENT_SECRET,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: j.error || res.statusText };
      const base = j.created_at ? Number(j.created_at) : Math.floor(Date.now() / 1000);
      const exp = base + Number(j.expires_in || 0) - 30;
      return {
        ok: true,
        access_token: j.access_token,
        refresh_token: j.refresh_token || refresh_token,
        expires_at: new Date(exp * 1000).toISOString(),
      };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  }

  function json(statusCode, body) {
    return {
      statusCode,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify(body),
    };
  }
};
