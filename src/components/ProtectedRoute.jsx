// File: src/components/ProtectedRoute.jsx
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../auth";
import SubscriptionGate from "./SubscriptionGate";

export default function ProtectedRoute() {
  const { user } = useAuth();
  const loc = useLocation();

  // Not logged in → bounce to login
  if (!user) return <Navigate to="/login" replace state={{ from: loc }} />;

  // Logged in → enforce active/trialing subscription
  return (
    <SubscriptionGate>
      <Outlet />
    </SubscriptionGate>
  );
}
