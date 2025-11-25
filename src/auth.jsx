// File: src/auth.jsx
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { supabase } from "./lib/supabaseClient.js"; // single canonical client

const AuthContext = createContext({ user: null, session: null, ready: false });

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);

  async function refreshSession() {
    const { data, error } = await supabase.auth.getSession();
    if (error) {
      // Optional: log or surface
      console.warn("[auth] getSession error:", error);
    }
    setSession(data?.session || null);
    setUser(data?.session?.user || null);
    setReady(true);
  }

  useEffect(() => {
    let cancelled = false;

    // 1) Initial restore
    refreshSession();

    // 2) Stay in sync with any changes (token refresh, sign-in/out, other tabs)
    const { data: sub } = supabase.auth.onAuthStateChange((_event, newSession) => {
      if (cancelled) return;
      setSession(newSession || null);
      setUser(newSession?.user || null);
      setReady(true);
    });

    // 3) Re-hydrate when the tab regains focus or becomes visible
    const onFocus = () => refreshSession();
    const onVisible = () => {
      if (document.visibilityState === "visible") refreshSession();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      sub?.subscription?.unsubscribe?.();
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const signup = async ({ email, password }) => {
    const origin =
      typeof window !== "undefined" && window.location?.origin
        ? window.location.origin
        : "https://remiecrm.com";

    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        // Where Supabase sends them AFTER they click the email link
        emailRedirectTo: `${origin}/auth/confirmed`,
      },
    });

    if (error) throw error;
    await refreshSession();
    return true;
  };

  const login = async ({ email, password }) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    await refreshSession();
    return true;
  };

  const logout = async () => {
    await supabase.auth.signOut();
    await refreshSession();
  };

  const value = useMemo(
    () => ({ user, session, ready, signup, login, logout }),
    [user, session, ready]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
