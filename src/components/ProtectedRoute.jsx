// File: src/components/ProtectedRoute.jsx
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useEffect, useState } from "react";
import { useAuth } from "../auth";
import SubscriptionGate from "./SubscriptionGate";
import { supabase } from "../lib/supabaseClient";
import useIsAdminAllowlist from "../lib/useIsAdminAllowlist.js";

// Toggle this to hide the banner for everyone:
const SHOW_BANNER_FOR_NON_OWNER = false;

// Simple banner shown when access is via team membership
function TeamAccessBanner({ teamName }) {
  return (
    <div className="w-full bg-emerald-600/10 text-emerald-300 border-b border-emerald-500/30 px-4 py-2 text-sm">
      Access provided by team: <span className="font-medium">{teamName}</span>
    </div>
  );
}

export default function ProtectedRoute({ requireAdmin = false, children }) {
  const { user, ready } = useAuth();
  const loc = useLocation();

  // Admin allowlist state (only used when requireAdmin = true)
  const { isAdmin, loading: adminLoading } = useIsAdminAllowlist();

  // Detect active team membership (owner or member)
  const [teamGateChecked, setTeamGateChecked] = useState(false);
  const [teamOk, setTeamOk] = useState(false);
  const [teamName, setTeamName] = useState("");
  const [viewerRole, setViewerRole] = useState(null); // 'owner' | 'member' | null

  useEffect(() => {
    let cancelled = false;

    async function checkTeamAccess() {
      if (!user?.id) {
        if (!cancelled) {
          setTeamGateChecked(true);
          setTeamOk(false);
          setViewerRole(null);
        }
        return;
      }

      try {
        // If a user can belong to multiple teams, this picks any active one.
        // Adjust with an .order(...) or additional filters if you want a canonical team.
        const { data, error } = await supabase
          .from("user_teams")
          .select("role, status, team:teams(name)")
          .eq("user_id", user.id)
          .eq("status", "active")
          .limit(1);

        if (!cancelled) {
          if (error) {
            setTeamOk(false);
            setViewerRole(null);
          } else if (Array.isArray(data) && data.length > 0) {
            setTeamOk(true);
            setViewerRole(data[0]?.role ?? null);
            setTeamName(data[0]?.team?.name || "Team");
          } else {
            setTeamOk(false);
            setViewerRole(null);
          }
          setTeamGateChecked(true);
        }
      } catch {
        if (!cancelled) {
          setTeamOk(false);
          setViewerRole(null);
          setTeamGateChecked(true);
        }
      }
    }

    if (ready && !requireAdmin) checkTeamAccess();
    else if (ready && requireAdmin) setTeamGateChecked(true); // skip team check for admin routes

    return () => {
      cancelled = true;
    };
  }, [ready, user?.id, requireAdmin]);

  // While Supabase restores the session after tabbing back, don't render or redirect yet
  if (!ready) {
    return (
      <div className="min-h-[40vh] grid place-items-center text-white/60">
        Loading…
      </div>
    );
  }

  // Must be logged in
  if (!user) return <Navigate to="/login" replace state={{ from: loc }} />;

  // --- Admin-only path: bypass subscription/team gates, enforce allowlist ---
  if (requireAdmin) {
    if (adminLoading) {
      return (
        <div className="min-h-[40vh] grid place-items-center text-white/60">
          Checking access…
        </div>
      );
    }
    if (!isAdmin) return <Navigate to="/app" replace />;
    // Render children when used as a wrapper; fall back to nested routing
    return <>{children ?? <Outlet />}</>;
  }

  // --- Normal path (non-admin routes): keep existing team/subscription logic ---
  if (!teamGateChecked) {
    return (
      <div className="min-h-[40vh] grid place-items-center text-white/60">
        Loading…
      </div>
    );
  }

  // If the user is an active team member, bypass the personal subscription gate
  if (teamOk) {
    const showBanner =
      SHOW_BANNER_FOR_NON_OWNER && viewerRole !== "owner";

    return (
      <>
        {showBanner && <TeamAccessBanner teamName={teamName} />}
        {children ?? <Outlet />}
      </>
    );
  }

  // Logged in but not a team member → enforce personal subscription (unchanged)
  return <SubscriptionGate>{children ?? <Outlet />}</SubscriptionGate>;
}
