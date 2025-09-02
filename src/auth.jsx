// File: src/auth.jsx
import { createContext, useContext, useEffect, useMemo, useState } from "react";
// ⬇️ Make sure this path matches your actual file location:
import { supabase } from "./lib/supabaseClient.js"; // <-- if yours is ./supabaseClient, change this line

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);   // full Supabase user or null
  const [ready, setReady] = useState(false); // true once we've checked at least once

  async function refreshSession() {
    const { data: { session } = {} } = await supabase.auth.getSession();
    setUser(session?.user ?? null);
    setReady(true);
  }

  useEffect(() => {
    let cancelled = false;

    // Initial snapshot
    refreshSession();

    // Subscribe to auth changes (also fires on token refresh)
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (cancelled) return;
      setUser(session?.user ?? null);
      setReady(true);
    });

    // Re-hydrate when tab regains focus or becomes visible
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
    const { error } = await supabase.auth.signUp({ email, password });
    if (error) throw error;
    await refreshSession();
    return true;
  };

  const login = async ({ email, password }) => {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    // data.user may be null if email confirmation is required; refresh to be sure
    await refreshSession();
    return data.user ?? null;
  };

  const logout = async () => {
    await supabase.auth.signOut();
    await refreshSession();
  };

  const value = useMemo(
    () => ({ user, ready, signup, login, logout }),
    [user, ready]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
