// netlify/functions/_supabase.js
const { createClient } = require("@supabase/supabase-js");
const fetch = require("node-fetch"); // ensure fetch exists for the fallback path

const SUPABASE_URL = process.env.SUPABASE_URL;

// allow either SUPABASE_SERVICE_ROLE or SUPABASE_SERVICE_ROLE_KEY
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY;

// ANON is optional here; only used in a rare fallback below
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL) console.warn("[_supabase] Missing SUPABASE_URL");
if (!SUPABASE_SERVICE_ROLE_KEY) console.warn("[_supabase] Missing SERVICE ROLE KEY");
// Don't warn for ANON here; we’ll warn only if the fallback path needs it.

/**
 * Service client (server-side privileges)
 */
function getServiceClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE(_KEY) env vars");
  }
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
}

/**
 * Extracts the Bearer token from a Netlify event OR a Request
 * and returns the authenticated user (or null).
 */
async function getUserFromRequest(eventOrReq) {
  try {
    // Netlify event (plain object headers) OR Request (Headers.get())
    const headers =
      eventOrReq?.headers?.get?.("authorization")
        ? { authorization: eventOrReq.headers.get("authorization") }
        : (eventOrReq?.headers || {});

    const authHeader =
      headers.authorization ||
      headers.Authorization ||
      headers.AUTHORIZATION ||
      "";

    const jwt = typeof authHeader === "string" && authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : null;

    if (!jwt) return null;

    // Use service client to decode/validate the JWT
    const svc = getServiceClient();
    const { data, error } = await svc.auth.getUser(jwt);
    if (error) return null;
    return data?.user || null;
  } catch (e) {
    // Fallback: direct call to /auth/v1/user using anon key if available
    try {
      const headers =
        eventOrReq?.headers?.get?.("authorization")
          ? { authorization: eventOrReq.headers.get("authorization") }
          : (eventOrReq?.headers || {});
      const authHeader =
        headers.authorization || headers.Authorization || "";
      if (!authHeader) return null;

      if (!SUPABASE_ANON_KEY) {
        console.warn("[_supabase] Fallback user fetch skipped: missing SUPABASE_ANON_KEY");
        return null;
      }

      const resp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: { Authorization: authHeader, apikey: SUPABASE_ANON_KEY },
      });
      if (!resp.ok) return null;
      return await resp.json();
    } catch {
      return null;
    }
  }
}

module.exports = {
  getServiceClient,
  getUserFromRequest,
};