import { getServiceClient } from "./_supabase.js";

export default async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state"); // user_id

  if (!code || !state) return new Response("Missing code/state", { status: 400 });

  const clientId = process.env.CALENDLY_CLIENT_ID;
  const clientSecret = process.env.CALENDLY_CLIENT_SECRET;
  const site = process.env.SITE_URL;
  const redirectUri = `${site}/.netlify/functions/calendly-auth-callback`;

  const tokenRes = await fetch("https://auth.calendly.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      code,
    }),
  });
  if (!tokenRes.ok) return new Response(`Token exchange failed: ${await tokenRes.text()}`, { status: 500 });

  const tok = await tokenRes.json();
  const expiresAt = new Date(Date.now() + (tok.expires_in - 60) * 1000).toISOString();

  const supa = getServiceClient();
  const { error } = await supa
    .from("calendly_tokens")
    .upsert({
      user_id: state,
      access_token: tok.access_token,
      refresh_token: tok.refresh_token,
      expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    });
  if (error) return new Response(`DB upsert error: ${error.message}`, { status: 500 });

  return Response.redirect(`${site}/app/calendar`, 302);
};
