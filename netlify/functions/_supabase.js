// netlify/functions/_supabase.js
const { createClient } = require("@supabase/supabase-js");
const fetch = require("node-fetch"); // used by the fallback path

const SUPABASE_URL = process.env.SUPABASE_URL;

// allow either SUPABASE_SERVICE_ROLE or SUPABASE_SERVICE_ROLE_KEY
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY;

// ANON is used by browser/client-style auth flows and our user-webhook GET
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

if (!SUPABASE_URL) console.warn("[_supabase] Missing SUPABASE_URL");
if (!SUPABASE_SERVICE_ROLE_KEY) console.warn("[_supabase] Missing SERVICE ROLE KEY");

function getServiceClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE(_KEY) env vars");
  }
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ✅ Anon client (preferred for verifying a user JWT passed from the browser)
function getAnonClient() {
  if (SUPABASE_URL && SUPABASE_ANON_KEY) {
    return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  // Fallback so things still work in dev if ANON isn’t set
  if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
    console.warn("[_supabase] Falling back to service role for anon client");
    return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  throw new Error("Missing SUPABASE_URL and SUPABASE_ANON_KEY");
}

/**
 * Extracts the Bearer token from a Netlify event OR a Request
 * and returns the authenticated user (or null).
 */
async function getUserFromRequest(eventOrReq) {
  try {
    const headers =
      eventOrReq?.headers?.get?.("authorization")
        ? { authorization: eventOrReq.headers.get("authorization") }
        : (eventOrReq?.headers || {});

    const authHeader =
      headers.authorization ||
      headers.Authorization ||
      headers.AUTHORIZATION ||
      "";

    const jwt =
      typeof authHeader === "string" && authHeader.startsWith("Bearer ")
        ? authHeader.slice(7).trim()
        : null;

    if (!jwt) return null;

    // Prefer anon client to validate the JWT
    const anon = getAnonClient();
    const { data, error } = await anon.auth.getUser(jwt);
    if (error) return null;
    return data?.user || null;
  } catch (e) {
    // Minimal HTTP fallback if needed
    try {
      const headers =
        eventOrReq?.headers?.get?.("authorization")
          ? { authorization: eventOrReq.headers.get("authorization") }
          : (eventOrReq?.headers || {});
      const authHeader = headers.authorization || headers.Authorization || "";
      if (!authHeader || !SUPABASE_ANON_KEY) return null;

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

/**
 * Compatibility wrapper used by some functions.
 * Reads Authorization header from a Netlify `event` and returns the user.
 */
async function getUserFromAuthHeader(event) {
  return getUserFromRequest(event);
}

module.exports = {
  getServiceClient,
  getAnonClient,
  getUserFromRequest,
  getUserFromAuthHeader, // 👈 export the name other functions expect
};
