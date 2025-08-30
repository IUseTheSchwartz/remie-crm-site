// netlify/functions/calendly-events.js
export default async () => {
  const token = process.env.CALENDLY_PAT;
  if (!token) {
    return new Response(JSON.stringify({ error: "Missing CALENDLY_PAT" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Get the current user URI (who the token belongs to)
  const meRes = await fetch("https://api.calendly.com/users/me", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!meRes.ok) {
    const t = await meRes.text();
    return new Response(JSON.stringify({ error: "users/me failed", detail: t }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
  const me = await meRes.json();
  const userUri = me?.resource?.uri;

  // Pull upcoming events
  const url = new URL("https://api.calendly.com/scheduled_events");
  url.searchParams.set("user", userUri);
  url.searchParams.set("status", "active");
  url.searchParams.set("min_start_time", new Date().toISOString());
  url.searchParams.set("sort", "start_time:asc");
  url.searchParams.set("count", "25");

  const evRes = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!evRes.ok) {
    const t = await evRes.text();
    return new Response(JSON.stringify({ error: "scheduled_events failed", detail: t }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
  const events = await evRes.json();

  return new Response(JSON.stringify({ events }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
};
