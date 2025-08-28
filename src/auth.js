// File: src/auth.js
import { createContext, useContext, useEffect, useMemo, useState } from "react";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);

  // Load user on first render (from localStorage)
  useEffect(() => {
    const raw = localStorage.getItem("remie_auth");
    if (raw) setUser(JSON.parse(raw));
  }, []);

  // Demo login: accepts any non-empty email/password
  const login = async ({ email, password }) => {
    if (!email || !password) throw new Error("Email and password required.");
    const u = { email };
    localStorage.setItem("remie_auth", JSON.stringify(u));
    setUser(u);
    return u;
  };

  const logout = () => {
    localStorage.removeItem("remie_auth");
    setUser(null);
  };

  const value = useMemo(() => ({ user, login, logout }), [user]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
