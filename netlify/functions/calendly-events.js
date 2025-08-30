import { getUserFromRequest, getServiceClient } from "./_supabase.js";

async function refreshToken(row) {
  const res = await fetch("https://auth.calendly.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: process.env.CALENDLY_CLIENT_ID,
      client_secret: process.env.CALENDLY_CLIENT_SECRET,
      refresh_token: row.refresh_token,
    }),
  });
  if (!res.ok) throw new Error(`Calendly refresh failed: ${await res.text()}`);
  const tok = await res.json();
  const expiresAt = new Date(Date.now() + (tok.expires_in - 60) * 1000).toISOString();
  return { access_token: tok.access_token, refresh_token: tok.refresh_token || row.refresh_token, expires_at: expiresAt };
}

export default async (req) => {
  const user = await getUserFromRequest(req);
  if (!user) return new Response("Unauthorized", { status: 401 });

  const supa = getServiceClient();
  const { data: row, error } = await supa
    .from("calendly_tokens")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) return new Response(`DB error: ${error.message}`, { status: 500 });

  if (!row) {
    return new Response(JSON.stringify({ error: "not_connected" }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }

  let { access_token, refresh_token, expires_at } = row;
  if (new Date(expires_at).getTime() <= Date.now()) {
    const refreshed = await refreshToken(row);
    access_token = refreshed.access_token;
    refresh_token = refreshed.refresh_token;
    expires_at = refreshed.expires_at;
    await supa.from("calendly_tokens")
      .update({ access_token, refresh_token, expires_at, updated_at: new Date().toISOString() })
      .eq("user_id", user.id);
  }

  const meRes = await fetch("https://api.calendly.com/users/me", {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  if (!meRes.ok) {
    return new Response(JSON.stringify({ error: "users_me_failed", detail: await meRes.text() }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
  const me = await meRes.json();
  const userUri = me?.resource?.uri;

  const url = new URL("https://api.calendly.com/scheduled_events");
  url.searchParams.set("user", userUri);
  url.searchParams.set("status", "active");
  url.searchParams.set("min_start_time", new Date().toISOString());
  url.searchParams.set("sort", "start_time:asc");
  url.searchParams.set("count", "25");

  const evRes = await fetch(url, { headers: { Authorization: `Bearer ${access_token}` } });
  if (!evRes.ok) {
    return new Response(JSON.stringify({ error: "events_failed", detail: await evRes.text() }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
  const events = await evRes.json();

  return new Response(JSON.stringify({ events }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
};
