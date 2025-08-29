import { useEffect, useMemo, useState, createContext, useContext } from "react";
import { BrowserRouter, Routes, Route, Navigate, Link, useLocation } from "react-router-dom";
import { supabase } from "./supabaseClient";

// PAGES
import LoginPage from "./pages/LoginPage";
import SignupPage from "./pages/SignupPage";
import Leads from "./pages/Leads";
import Reports from "./pages/Reports";
import Settings from "./pages/Settings";
import AgentShowcase from "./pages/AgentShowcase";
import AgentPublic from "./pages/AgentPublic";

/** ---------------------------
 *  Auth Context
 *  ---------------------------
 */
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

/** ProtectedRoute – must be logged in */
function ProtectedRoute({ children }) {
  const { authReady, user } = useAuth();
  const location = useLocation();

  if (!authReady) return <ScreenCenter>Loading…</ScreenCenter>;
  if (!user) return <Navigate to="/login" state={{ from: location }} replace />;
  return children;
}

/** SubscriptionGate – must have an active subscription */
function SubscriptionGate({ children }) {
  const { user } = useAuth();
  const [ok, setOk] = useState(null);

  useEffect(() => {
    let ignore = false;
    async function load() {
      if (!user?.id) return setOk(false);
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
    load();
    return () => {
      ignore = true;
    };
  }, [user?.id]);

  if (ok === null) return <ScreenCenter>Checking subscription…</ScreenCenter>;
  if (!ok) {
    return (
      <ScreenCenter>
        <div className="text-center space-y-3">
          <div className="text-xl font-semibold">Subscription required</div>
          <p className="text-gray-600 max-w-md">
            Your account doesn’t have an active plan. Please subscribe from the pricing page, or
            update your billing in <Link className="underline" to="/settings">Settings</Link>.
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

/** Sidebar Layout */
function AppLayout({ children }) {
  const { user } = useAuth();
  const location = useLocation();

  const link = (to, label) => {
    const active = location.pathname === to || location.pathname.startsWith(to + "/");
    return (
      <Link
        to={to}
        className={`block px-3 py-2 rounded-xl ${active ? "bg-gray-900 text-white" : "hover:bg-gray-100"}`}
      >
        {label}
      </Link>
    );
  };

  return (
    <div className="min-h-screen flex">
      <aside className="w-56 border-r px-3 py-4 space-y-2">
        <div className="text-lg font-semibold mb-2">Remie CRM</div>
        {link("/leads", "Leads")}
        {link("/reports", "Reports")}
        {link("/agent-showcase", "Agent Showcase")}
        {link("/settings", "Settings")}
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

/** ---------------------------
 *  App Routes
 *  ---------------------------
 */
export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          {/* Root goes to Login */}
          <Route path="/" element={<Navigate to="/login" replace />} />
          <Route path="/login" element={<AuthShell><LoginPage /></AuthShell>} />
          <Route path="/signup" element={<AuthShell><SignupPage /></AuthShell>} />

          {/* Public agent profile */}
          <Route path="/agent/:slug" element={<AgentPublic />} />

          {/* Protected */}
          <Route
            path="/leads"
            element={
              <ProtectedRoute>
                <SubscriptionGate>
                  <AppLayout><Leads /></AppLayout>
                </SubscriptionGate>
              </ProtectedRoute>
            }
          />
          <Route
            path="/reports"
            element={
              <ProtectedRoute>
                <SubscriptionGate>
                  <AppLayout><Reports /></AppLayout>
                </SubscriptionGate>
              </ProtectedRoute>
            }
          />
          <Route
            path="/settings"
            element={
              <ProtectedRoute>
                <SubscriptionGate>
                  <AppLayout><Settings /></AppLayout>
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

          {/* Fallback */}
          <Route path="*" element={<NotFound />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}

/** Helpers */
function NotFound() {
  return (
    <ScreenCenter>
      <div className="text-center space-y-3">
        <div className="text-xl font-semibold">Page not found</div>
        <Link className="underline" to="/login">Go to Login</Link>
      </div>
    </ScreenCenter>
  );
}

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
