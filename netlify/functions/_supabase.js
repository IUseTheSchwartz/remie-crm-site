// netlify/functions/_supabase.js
const supabasePkg = require("@supabase/supabase-js");
const { createClient } = supabasePkg;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Optional helper if you ever pass a Request-like object (e.g., Remix/Next API routes)
async function getUserFromRequest(req) {
  try {
    const auth = (req?.headers?.get?.("authorization") || req?.headers?.authorization || "") + "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return null;

    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function getServiceClient() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
}

module.exports = {
  getUserFromRequest,
  getServiceClient,
};
