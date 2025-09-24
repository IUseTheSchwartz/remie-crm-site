// File: src/hooks/useIsAdminAllowlist.js
import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient.js";

export default function useIsAdminAllowlist() {
  const [loading, setLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    let mounted = true;
    (async () => {
      setLoading(true);
      const { data: { user } } = await supabase.auth.getUser();
      if (!user?.email) { 
        if (mounted) { setIsAdmin(false); setLoading(false); }
        return; 
      }

      const { data, error } = await supabase
        .from("admin_allowlist")
        .select("email")
        .eq("email", user.email.toLowerCase())
        .maybeSingle();

      if (mounted) {
        setIsAdmin(!error && !!data);
        setLoading(false);
      }
    })();

    return () => { mounted = false; };
  }, []);

  return { isAdmin, loading };
}
