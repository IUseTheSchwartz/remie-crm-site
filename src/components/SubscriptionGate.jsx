// File: src/components/SubscriptionGate.jsx
import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { useAuth } from "../auth";

const ACTIVE_STATUSES = new Set(["active", "trialing"]);

export default function SubscriptionGate({ children }) {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [admit, setAdmit] = useState(false);
  const [foundStatus, setFoundStatus] = useState(null);
  const [reason, setReason] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (!user) {
        setLoading(false);
        setAdmit(false);
        setFoundStatus(null);
        setReason("no user");
        return;
      }

      try {
        // 1) Check personal subscription
        const { data: subRows, error: subErr } = await supabase
          .from("subscriptions")
          .select("status, current_period_end")
          .eq("user_id", user.id)
          .order("current_period_end", { ascending: false })
          .limit(1);

        if (subErr) throw subErr;

        let ok = false;
        let statusStr = null;

        if (Array.isArray(subRows) && subRows.length) {
          statusStr = (subRows[0].status || "").toLowerCase();
          if (ACTIVE_STATUSES.has(statusStr)) {
            ok = true;
          }
        }

        // 2) If no personal sub, allow via team membership (seat invite)
        if (!ok) {
          const { data: teamRows, error: teamErr } = await supabase
            .from("user_teams")
            .select("team_id, role, status")
            .eq("user_id", user.id)
            .eq("status", "active")
            .limit(1);

          if (teamErr) throw teamErr;
          if (Array.isArray(teamRows) && teamRows.length) {
            ok = true;
            statusStr = statusStr || "team-member";
          }
        }

        if (!cancelled) {
          setAdmit(ok);
          setFoundStatus(statusStr);
          setReason(ok ? "ok" : "no active sub or team");
          setLoading(false);
        }
      } catch (e) {
        if (!cancelled) {
          setAdmit(false);
          setFoundStatus(null);
          setReason(e.message || "error");
          setLoading(false);
        }
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  if (loading) {
    return (
      <div className="min-h-[40vh] grid place-items-center text-white/60">
        Checking subscription…
      </div>
    );
  }

  if (admit) {
    return children;
  }

  // Blocked UI
  return (
    <div className="min-h-[60vh] grid place-items-center">
      <div className="w-full max-w-xl rounded-2xl border border-white/10 bg-white/[0.03] p-6 text-white">
        <h2 className="text-xl font-semibold">Subscribe to access Remie CRM</h2>
        <p className="mt-1 text-sm text-white/70">
          Your account is logged in, but we didn’t find an active subscription for this workspace.
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

        {/* Debug line so you can see what we detected */}
        <div className="mt-3 text-xs text-white/50">
          {foundStatus ? `Found subscription: ${foundStatus}` : "No subscription found"}
          {reason && ` • ${reason}`}
        </div>
      </div>
    </div>
  );
}