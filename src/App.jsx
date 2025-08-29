// File: src/App.jsx
import React, { useEffect, useMemo, useState, createContext, useContext } from "react";
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  Link,
  useLocation,
} from "react-router-dom";
import { supabase } from "./supabaseClient";

/* =========================
   Pages (adjust names if needed)
   ========================= */
import LoginPage from "./pages/LoginPage";
import SignupPage from "./pages/SignupPage";
import LeadsPage from "./pages/LeadsPage";
import ReportsPage from "./pages/ReportsPage";
import SettingsPage from "./pages/SettingsPage";
import AgentShowcase from "./pages/AgentShowcase";
import AgentPublic from "./pages/AgentPublic";

/* =========================
   Auth Context (Supabase)
   ========================= */
const AuthContext = createContext(null);
export const useAuth = () => useContext(AuthContext);

function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [authReady, setAuthReady] = useState(false);

  useEffect(() => {
    let mounted = true;

    (async () => {
      const { data } = await supabase.auth.getUser();
      if (mounted) {
        setUser(data.user ?? null);
        setAuthReady(true);
      }
    })();

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });

    return () => {
      mounted = false;
      sub.subscription?.unsubscribe();
    };
  }, []);

  const value = useMemo(() => ({ user, setUser, authReady }), [user, authReady]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/* =========================
   Route Guards
   ========================= */
function ProtectedRoute({ children }) {
  const { authReady, user } = useAuth();
  const location = useLocation();

  if (!authReady) return <ScreenCenter>Loading…</ScreenCenter>;
  if (!user) return <Navigate to="/login" state={{ from: location }} replace />;
  return children;
}

/** Requires an active subscription in public.subscriptions
 *  Allowed statuses: active | trialing | past_due  */
function SubscriptionGate({ children }) {
  const { user } = useAuth();
  const [ok, setOk] = useState(null);

  useEffect(() => {
    let ignore = false;
    async function check() {
      if (!user?.id) {
        setOk(false);
        return;
      }
      const { data, error } = await supabase
        .from("subscriptions")
        .select("status")
        .eq("user_id", user.id)
        .maybeSingle();

      if (ignore) return;

      if (error) {
        console.error(error);
        setOk(false);
        return;
      }

      const status = (data?.status || "").toLowerCase();
      const allowed = ["active", "trialing", "past_due"];
      setOk(allowed.includes(status));
    }
    check();
    return () => { ignore = true; };
  }, [user?.id]);

  if (ok === null) return <ScreenCenter>Checking subscription…</ScreenCenter>;
  if (!ok) {
    return (
      <ScreenCenter>
        <div className="text-center space-y-3">
          <div className="text-xl font-semibold">Subscription required</div>
          <p className="text-gray-600 max-w-md mx-auto">
            Your account doesn’t have an active plan. Please subscribe or update billing in{" "}
            <Link className="underline" to="/settings">Settings</Link>.
          </p>
          <Link className="inline-block px-4 py-2 rounded-xl bg-black text-white" to="/login">
            Go to Login
          </Link>
        </div>
      </ScreenCenter>
    );
  }
  return children;
}

/* =========================
   App Layout (sidebar)
   ========================= */
function AppLayout({ children }) {
  const { user } = useAuth();
  const location = useLocation();

  const NavItem = ({ to, children: label }) => {
    const active = location.pathname === to || location.pathname.startsWith(to + "/");
    return (
      <Link
        to={to}
        className={`block px-3 py-2 rounded-xl ${
          active ? "bg-gray-900 text-white" : "hover:bg-gray-100"
        }`}
      >
        {label}
      </Link>
    );
  };

  return (
    <div className="min-h-screen flex">
      <aside className="w-56 border-r px-3 py-4 space-y-2">
        <div className="text-lg font-semibold mb-2">Remie CRM</div>
        <NavItem to="/leads">Leads</NavItem>
        <NavItem to="/reports">Reports</NavItem>
        <NavItem to="/agent-showcase">Agent Showcase</NavItem>
        <NavItem to="/settings">Settings</NavItem>

        <div className="mt-6 pt-3 border-t text-sm text-gray-500">
          {user?.email || "—"}
        </div>
        <button
          className="mt-2 text-sm text-gray-500 underline"
          onClick={async () => { await supabase.auth.signOut(); }}
        >
          Sign out
        </button>
      </aside>

      <main className="flex-1 p-5">{children}</main>
    </div>
  );
}

/* =========================
   App Routes
   ========================= */
export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          {/* Root → Login */}
          <Route path="/" element={<Navigate to="/login" replace />} />
          <Route path="/login" element={<AuthShell><LoginPage /></AuthShell>} />
          <Route path="/signup" element={<AuthShell><SignupPage /></AuthShell>} />

          {/* Public agent profile */}
          <Route path="/agent/:slug" element={<AgentPublic />} />

          {/* Private app pages (auth + subscription) */}
          <Route
            path="/leads"
            element={
              <ProtectedRoute>
                <SubscriptionGate>
                  <AppLayout><LeadsPage /></AppLayout>
                </SubscriptionGate>
              </ProtectedRoute>
            }
          />
          <Route
            path="/reports"
            element={
              <ProtectedRoute>
                <SubscriptionGate>
                  <AppLayout><ReportsPage /></AppLayout>
                </SubscriptionGate>
              </ProtectedRoute>
            }
          />
          <Route
            path="/settings"
            element={
              <ProtectedRoute>
                <SubscriptionGate>
                  <AppLayout><SettingsPage /></AppLayout>
                </SubscriptionGate>
              </ProtectedRoute>
            }
          />
          <Route
            path="/agent-showcase"
            element={
              <ProtectedRoute>
                <SubscriptionGate>
                  <AppLayout><AgentShowcase /></AppLayout>
                </SubscriptionGate>
              </ProtectedRoute>
            }
          />

          {/* Catch-all → Login */}
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}

/* =========================
   Small helpers
   ========================= */
function ScreenCenter({ children }) {
  return (
    <div className="min-h-[60vh] flex items-center justify-center p-6">
      {children}
    </div>
  );
}

function AuthShell({ children }) {
  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-md border rounded-2xl p-6 shadow-sm">
        {children}
      </div>
    </div>
  );
}
