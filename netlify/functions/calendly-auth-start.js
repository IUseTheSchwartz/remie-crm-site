import { getUserFromRequest } from "./_supabase.js";

export default async (req) => {
  const user = await getUserFromRequest(req);
  if (!user) return new Response("Unauthorized", { status: 401 });

  const clientId = process.env.CALENDLY_CLIENT_ID;
  const site = process.env.SITE_URL;
  const redirectUri = `${site}/.netlify/functions/calendly-auth-callback`;
  const state = encodeURIComponent(user.id);

  const authUrl = new URL("https://auth.calendly.com/oauth/authorize");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("state", state);

  return Response.redirect(authUrl.toString(), 302);
};
