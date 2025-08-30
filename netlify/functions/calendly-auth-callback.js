// File: netlify/functions/calendly-auth-callback.js
// Node 18+ on Netlify has global fetch—do NOT import "node-fetch".

/**
 * Environment variables required (set in Netlify > Site settings > Build & deploy > Environment):
 * - CALENDLY_CLIENT_SECRET         (server-only – keep secret)
 * - VITE_CALENDLY_CLIENT_ID        (also used on the client)
 * - CALENDLY_REDIRECT_URI          (must exactly match the Redirect URI in Calendly Dev Console)
 *
 * Example CALENDLY_REDIRECT_URI:
 *   https://YOURDOMAIN.com/.netlify/functions/calendly-auth-callback
 */

const TOKEN_URL = 'https://auth.calendly.com/oauth/token';
const CURRENT_USER_URL = 'https://api.calendly.com/users/me';

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'GET') {
      return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const params = new URLSearchParams(event.rawQuery || event.queryStringParameters || {});
    const code = params.get('code');

    if (!code) {
      return { statusCode: 400, body: 'Missing ?code in callback URL' };
    }

    const clientId = process.env.VITE_CALENDLY_CLIENT_ID;
    const clientSecret = process.env.CALENDLY_CLIENT_SECRET;
    const redirectUri = process.env.CALENDLY_REDIRECT_URI;

    if (!clientId || !clientSecret || !redirectUri) {
      return {
        statusCode: 500,
        body: 'Server missing env vars VITE_CALENDLY_CLIENT_ID / CALENDLY_CLIENT_SECRET / CALENDLY_REDIRECT_URI',
      };
    }

    // 1) Exchange authorization code for access token
    const tokenRes = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        // Calendly expects Basic auth with base64(client_id:client_secret)
        Authorization:
          'Basic ' + Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri, // MUST match what Calendly has on your OAuth app
      }),
    });

    const tokenJson = await tokenRes.json();

    if (!tokenRes.ok) {
      return {
        statusCode: tokenRes.status,
        body: `Token exchange failed: ${JSON.stringify(tokenJson)}`,
      };
    }

    const { access_token, refresh_token, expires_in, token_type } = tokenJson;

    // (Optional) confirm the token belongs to the expected user
    const meRes = await fetch(CURRENT_USER_URL, {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    const meJson = await meRes.json();
    if (!meRes.ok) {
      return {
        statusCode: meRes.status,
        body: `Failed to fetch /users/me: ${JSON.stringify(meJson)}`,
      };
    }

    // We’ll pass the token back to the front-end through a small redirect with a fragment
    // so it doesn’t hit logs or browser history querystrings.
    const frontUrl = new URL(process.env.SITE_URL || 'http://localhost:5173');
    // Send users to app Settings where we store the token; change path if you want a different destination:
    frontUrl.pathname = '/app/settings';
    frontUrl.hash = `#calendly_oauth=success&access_token=${encodeURIComponent(
      access_token
    )}&refresh_token=${encodeURIComponent(refresh_token || '')}&expires_in=${encodeURIComponent(
      expires_in
    )}&token_type=${encodeURIComponent(token_type || 'Bearer')}`;

    return {
      statusCode: 302,
      headers: { Location: frontUrl.toString() },
      body: '',
    };
  } catch (err) {
    return { statusCode: 500, body: `Callback error: ${err.message}` };
  }
};
