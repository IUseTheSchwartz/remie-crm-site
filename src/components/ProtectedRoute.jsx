// File: src/components/ProtectedRoute.jsx
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../auth";
import SubscriptionGate from "./SubscriptionGate";

export default function ProtectedRoute() {
  const { user, ready } = useAuth();   // ← include `ready` from AuthProvider
  const loc = useLocation();

  // While Supabase restores the session after tabbing back, don't render or redirect yet
  if (!ready) {
    return (
      <div className="min-h-[40vh] grid place-items-center text-white/60">
        Loading…
      </div>
    );
  }

  // After hydration, if still no user → bounce to login
  if (!user) return <Navigate to="/login" replace state={{ from: loc }} />;

  // Logged in → enforce subscription and render the page
  return (
    <SubscriptionGate>
      <Outlet />
    </SubscriptionGate>
  );
}
