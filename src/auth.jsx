// File: src/auth.jsx
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { supabase } from "./lib/supabaseClient.js";

const AuthCtx = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);   // auth bootstrapped
  const [subOk, setSubOk] = useState(null);    // null=unknown, true/false after check

  useEffect(() => {
    let cancelled = false;
    let timeoutId;

    async function bootstrap() {
      // 1) Get current session quickly
      const { data: { session } } = await supabase.auth.getSession();
      if (!cancelled) setUser(session?.user ?? null);

      // 2) Start a safety timeout so we never hang on UI spinners
      timeoutId = window.setTimeout(() => {
        if (!cancelled) setReady(true);
      }, 6000); // 6s fallback

      // 3) Listen for auth changes across tabs
      const { data: sub } = supabase.auth.onAuthStateChange((_event, sess) => {
        setUser(sess?.user ?? null);
        // When we get any auth event, auth is definitely bootstrapped
        setReady(true);
      });

      // 4) If we *already* had a session, mark ready immediately
      if (session) {
        setReady(true);
      }

      return () => {
        sub?.subscription?.unsubscribe?.();
      };
    }

    bootstrap();

    return () => {
      cancelled = true;
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, []);

  // OPTIONAL: Lightweight subscription check that won’t block UI forever
  useEffect(() => {
    let cancelled = false;
    async function checkSubscription() {
      setSubOk(null);
      if (!user) { setSubOk(true); return; } // allow unauth or public pages
      try {
        // Replace with your real query if you gate parts of /app by subscription
        // Example table: billing_subscriptions with RLS by user_id
        const { data, error } = await supabase
          .from("billing_subscriptions")
          .select("status")
          .eq("user_id", user.id)
          .maybeSingle();
        if (!cancelled) setSubOk(error ? true : (data?.status === "active" || data?.status === "trialing"));
      } catch {
        if (!cancelled) setSubOk(true); // fail open so we don’t block
      }
    }
    checkSubscription();
    return () => { cancelled = true; };
  }, [user]);

  const value = useMemo(() => ({
    user, ready, subOk,
    async logout() { await supabase.auth.signOut(); }
  }), [user, ready, subOk]);

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth() {
  return useContext(AuthCtx);
}
