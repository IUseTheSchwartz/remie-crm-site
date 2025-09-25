// netlify/functions/_supa.js
const { createClient } = require("@supabase/supabase-js");

function supaAdmin() {
  const key = process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY;
  return createClient(process.env.SUPABASE_URL, key);
}
module.exports = { supaAdmin };
