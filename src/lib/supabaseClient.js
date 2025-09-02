// File: src/lib/supabaseClient.js
import { createClient } from "@supabase/supabase-js";

// These come from your Netlify/Vite env vars
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn(
    "[supabaseClient] Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. " +
      "Set them in your environment variables."
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,        // keep session in storage
    autoRefreshToken: true,      // refresh tokens automatically
    detectSessionInUrl: true,    // parse OAuth callbacks
    storageKey: "remiecrm.auth", // avoid collisions across apps/domains
  },
});

export default supabase;
