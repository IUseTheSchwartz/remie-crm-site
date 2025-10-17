// netlify/functions/_supa.js
// Unified Supabase helpers for Netlify Functions.
// Exports an admin client and a helper to resolve the caller (via Bearer JWT).

const { createClient } = require("@supabase/supabase-js");

const URL = process.env.SUPABASE_URL;
const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!URL || !SERVICE_KEY) {
  console.warn(
    "[_supa] Missing SUPABASE_URL and/or SUPABASE_SERVICE_ROLE env vars."
  );
}

// Create a single admin client (service role). No session persistence in functions.
const supabase = createClient(URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

/**
 * Back-compat alias some functions use.
 */
function getServiceClient() {
  return supabase;
}

/**
 * Also keep old name you had (`supaAdmin`) for compatibility.
 */
function supaAdmin() {
  return supabase;
}

/**
 * Extract the authenticated user from a Netlify Function event by reading
 * `Authorization: Bearer <supabase-jwt>` and validating it with Supabase.
 *
 * @param {import('@netlify/functions').HandlerEvent} event
 * @returns {Promise<{ user?: any, error?: string }>}
 */
async function getUserFromEvent(event) {
  try {
    const auth =
      event.headers.authorization || event.headers.Authorization || "";
    if (!auth.startsWith("Bearer ")) {
      return { error: "missing_bearer" };
    }
    const token = auth.slice(7).trim();
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) return { error: "bad_token" };
    return { user: data.user };
  } catch (e) {
    return { error: e?.message || "get_user_failed" };
  }
}

module.exports = {
  supabase,
  getServiceClient, // preferred
  supaAdmin,        // legacy name kept
  getUserFromEvent,
};
