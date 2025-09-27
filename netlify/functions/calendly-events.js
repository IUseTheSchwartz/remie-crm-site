// netlify/functions/calendly-events.js
// Safe session resolution, verbose debug, PAT fallback.

const fetch = require("node-fetch");
const { getServiceClient, getUserFromRequest } = require("./_supabase");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY;
const CALENDLY_CLIENT_ID = process.env.CALENDLY_CLIENT_ID;
const CALENDLY_CLIENT_SECRET = process.env.CALENDLY_CLIENT_SECRET;

const CALENDLY_PAT =
  process.env.CALENDLY_PAT ||
  process.env.CALENDLY_ACCESS_TOKEN ||
  process.env.CALENDLY_TOKEN ||
  null;

const supabase = getServiceClient();

function j(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  const debug = (() => {
    try { return new URL(event.rawUrl).searchParams.get("debug") === "1"; }
    catch { return false; }
  })();

  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
      return j(500, { error: "Missing Supabase env vars (SUPABASE_URL / SUPABASE_SERVICE_ROLE)" });
    }
    if (!CALENDLY_CLIENT_ID || !CALENDLY_CLIENT_SECRET) {
      if (!CALENDLY_PAT) {
        return j(500, { error: "Missing Calendly CLIENT_ID/SECRET and no CALENDLY_PAT fallback" });
      }
    }

    const url = new URL(event.rawUrl);
    let uid = url.searchParams.get("uid");
    const count = Math.max(1, Math.min(100, Number(url.searchParams.get("count") || 50)));

    // SAFE session resolution (no destructuring on null)
    if (!uid) {
      let resolved = null;
      try {
        resolved = await getUserFromRequest(event, supabase);
      } catch (e) {
        if (debug) console.error("[calendly-events] getUserFromRequest threw:", e);
      }
      if (!resolved || resolved.error || !resolved.user) {
        return j(401, { error: "Not signed in and no uid provided" });
      }
      uid = resolved.user.id;
    }

    // ===== Acquire Calendly access token =====
    let access_token = null;
    let refresh_token = null;
    let expires_at = null;

    if (CALENDLY_PAT) {
      access_token = CALENDLY_PAT;
    } else {
      const tokenUrl =
        `${SUPABASE_URL}/rest/v1/calendly_tokens?user_id=eq.` +
        encodeURIComponent(uid) +
        `&select=access_token,refresh_token,expires_at`;

      const tRes = await fetch(tokenUrl, {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
        },
      });

      if (!tRes.ok) {
        const body = await tRes.text().catch(() => "");
        if (debug) console.error("[calendly-events] token lookup failed:", tRes.status, body);
        return j(500, { error: "Token lookup failed", detail: debug ? body : undefined });
      }

      let row;
      try {
        const arr = await tRes.json();
        row = Array.isArray(arr) ? arr[0] : null;
      } catch (e) {
        if (debug) console.error("[calendly-events] token JSON parse error:", e);
        return j(500, { error: "Token JSON parse error", detail: debug ? String(e) : undefined });
      }

      if (!row) return j(404, { error: "No Calendly token for user" });

      access_token = row.access_token;
      refresh_token = row.refresh_token;
      expires_at = row.expires_at;

      // Refresh if near expiry
      const expMs = new Date(expires_at).getTime();
      if (!Number.isNaN(expMs) && expMs < Date.now() + 30_000) {
        const refreshed = await refresh(refresh_token);
        if (!refreshed.ok) {
          if (debug) console.error("[calendly-events] refresh failed:", refreshed.error);
          return j(401, { error: "Calendly token refresh failed", detail: debug ? refreshed.error : undefined });
        }
        access_token = refreshed.access_token;
        refresh_token = refreshed.refresh_token;
        expires_at = refreshed.expires_at;

        // Persist
        const upRes = await fetch(`${SUPABASE_URL}/rest/v1/calendly_tokens`, {
          method: "POST",
          headers: {
            apikey: SUPABASE_SERVICE_ROLE,
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
            "Content-Type": "application/json",
            Prefer: "resolution=merge-duplicates",
          },
          body: JSON.stringify([{ user_id: uid, access_token, refresh_token, expires_at }]),
        });
        if (!upRes.ok && debug) {
          const body = await upRes.text().catch(() => "");
          console.error("[calendly-events] upsert failed:", upRes.status, body);
        }
      }
    }

    // ===== Resolve Calendly user URI =====
    const meRes = await fetch("https://api.calendly.com/users/me", {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    const meTxt = await meRes.text();
    let meJson = {};
    try { meJson = meTxt ? JSON.parse(meTxt) : {}; } catch {}
    if (!meRes.ok) {
      if (debug) console.error("[calendly-events] /users/me failed:", meRes.status, meTxt);
      return j(meRes.status, { error: "users/me failed", detail: debug ? meJson || meTxt : undefined });
    }
    const userUri = meJson?.resource?.uri;
    if (!userUri) return j(500, { error: "Missing user uri from Calendly", detail: debug ? meJson : undefined });

    // ===== Pull events (now → +30 days) =====
    const now = new Date();
    const max = new Date(now); max.setDate(max.getDate() + 30);

    const qs = new URLSearchParams({
      user: userUri,
      status: "active",
      sort: "start_time:asc",
      min_start_time: now.toISOString(),
      max_start_time: max.toISOString(),
      count: String(count),
    });

    const evRes = await fetch(`https://api.calendly.com/scheduled_events?${qs.toString()}`, {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    const evTxt = await evRes.text();
    let evJson = {};
    try { evJson = evTxt ? JSON.parse(evTxt) : {}; } catch {}
    if (!evRes.ok) {
      if (debug) console.error("[calendly-events] /scheduled_events failed:", evRes.status, evTxt);
      return j(evRes.status, { error: "scheduled_events failed", detail: debug ? evJson || evTxt : undefined });
    }

    return j(200, evJson);
  } catch (err) {
    if (debug) console.error("[calendly-events] unhandled:", err);
    return j(500, { error: err?.message || String(err) });
  }
};

// ---- helpers ----
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
    const txt = await res.text();
    let jn = {};
    try { jn = txt ? JSON.parse(txt) : {}; } catch {}
    if (!res.ok) return { ok: false, error: jn.error || txt || res.statusText };

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
