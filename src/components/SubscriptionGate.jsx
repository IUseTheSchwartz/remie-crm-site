// File: src/components/SubscriptionGate.jsx
import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { useAuth } from "../auth";

// Treat only these as paid
const ACTIVE_STATUSES = new Set(["active", "trialing"]);
const norm = (s) => (s || "").toLowerCase().trim();

export default function SubscriptionGate({ children }) {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [admit, setAdmit] = useState(false);
  const [foundStatus, setFoundStatus] = useState(null); // for your debug line
  const [reason, setReason] = useState("");              // for your debug line

  useEffect(() => {
    let cancelled = false;

    async function checkAccess() {
      // No user → definitely block (but no white screen)
      if (!user) {
        if (!cancelled) {
          setAdmit(false);
          setFoundStatus(null);
          setReason("no user");
          setLoading(false);
        }
        return;
      }

      try {
        // ----- 1) Personal subscription check (robust to RLS/SQL errors) -----
        let statusStr = null;
        let ok = false;

        try {
          const { data: subRows, error: subErr } = await supabase
            .from("subscriptions")
            .select("status, current_period_end")
            .eq("user_id", user.id)
            .order("current_period_end", { ascending: false, nullsLast: true })
            .limit(1);

          if (!subErr && Array.isArray(subRows) && subRows.length) {
            statusStr = norm(subRows[0].status);
            if (ACTIVE_STATUSES.has(statusStr)) ok = true;
          } else if (subErr) {
            // Don’t crash on RLS or table errors—just log and continue to team check
            console.warn("[SubscriptionGate] subscriptions query error:", subErr.message || subErr);
          }
        } catch (e) {
          console.warn("[SubscriptionGate] subscriptions query threw:", e?.message || e);
        }

        // ----- 2) Team membership fallback (seats can use CRM) -----
        if (!ok) {
          try {
            const { data: teamRows, error: teamErr } = await supabase
              .from("user_teams")
              .select("team_id, status")
              .eq("user_id", user.id)
              .eq("status", "active")
              .limit(1);

            if (!teamErr && Array.isArray(teamRows) && teamRows.length) {
              ok = true;
              if (!statusStr) statusStr = "team-member";
            } else if (teamErr) {
              console.warn("[SubscriptionGate] user_teams query error:", teamErr.message || teamErr);
            }
          } catch (e) {
            console.warn("[SubscriptionGate] user_teams query threw:", e?.message || e);
          }
        }

        if (!cancelled) {
          setAdmit(ok);
          setFoundStatus(statusStr);
          setReason(ok ? "ok" : "no active sub or team");
          setLoading(false);
        }
      } catch (e) {
        // Absolute last-ditch safety: never blank screen
        console.error("[SubscriptionGate] fatal:", e);
        if (!cancelled) {
          setAdmit(false);
          setFoundStatus(null);
          setReason("error");
          setLoading(false);
        }
      }
    }

    setLoading(true);
    setAdmit(false);
    setFoundStatus(null);
    setReason("");
    checkAccess();

    return () => { cancelled = true; };
  }, [user?.id]);

  // Loading state (prevents white flash)
  if (loading) {
    return (
      <div className="min-h-[40vh] grid place-items-center text-white/60">
        Checking subscription…
      </div>
    );
  }

  // Allowed → render app
  if (admit) return children;

  // Blocked UI (never blank)
  return (
    <div className="min-h-[60vh] grid place-items-center">
      <div className="w-full max-w-xl rounded-2xl border border-white/10 bg-white/[0.03] p-6 text-white">
        <h2 className="text-xl font-semibold">Subscribe to access Remie CRM</h2>
        <p className="mt-1 text-sm text-white/70">
          You’re logged in, but we didn’t find an active subscription for this account.
          If you were invited to a team, ask your team owner to add you.
        </p>

        <div className="mt-4 flex items-center gap-2">
          <button
            onClick={() => window.location.reload()}
            className="rounded-xl border border-white/15 px-4 py-2 text-sm hover:bg-white/5"
          >
            Refresh status
          </button>
          <a
            href="/app/settings"
            className="rounded-xl bg-white/10 px-4 py-2 text-sm hover:bg-white/20"
          >
            Subscribe
          </a>
        </div>

        {/* Debug line you wanted to keep */}
        <div className="mt-3 text-xs text-white/50">
          {foundStatus ? `Found subscription: ${foundStatus}` : "No subscription found"}
          {reason ? ` • ${reason}` : ""}
        </div>
      </div>
    </div>
  );
}