// File: src/lib/supabaseClient.js
import { createClient } from "@supabase/supabase-js";

// These come from your Netlify/Vite env vars
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  // Helpful error if env vars are missing at build or runtime
  console.warn(
    "[supabaseClient] Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. " +
      "Set them in Netlify > Site settings > Build & deploy > Environment."
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
export default supabase;
