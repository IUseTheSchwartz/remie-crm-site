// File: src/components/SubscriptionGate.jsx
import { useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { useAuth } from "../auth";
import { startCheckout, getPriceId } from "../lib/billing"; // ✅ use your existing helper

const ACTIVE_STATUSES = new Set(["active", "trialing"]);
const norm = (s) => (s || "").toLowerCase().trim();

export default function SubscriptionGate({ children }) {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [admit, setAdmit] = useState(false);
  const [foundStatus, setFoundStatus] = useState(null);
  const [reason, setReason] = useState("");
  const timeoutRef = useRef(null);

  useEffect(() => {
    let cancelled = false;

    async function safeCheck() {
      if (!user) {
        if (!cancelled) {
          setAdmit(false);
          setFoundStatus(null);
          setReason("no user");
          setLoading(false);
        }
        return;
      }

      clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => {
        if (!cancelled) {
          setLoading(false);
          setAdmit(false);
          setFoundStatus(null);
          setReason("timeout");
        }
      }, 8000);

      try {
        let ok = false;
        let statusStr = null;

        // 1) Personal subscription
        try {
          const { data, error } = await supabase
            .from("subscriptions")
            .select("status, current_period_end")
            .eq("user_id", user.id)
            .order("current_period_end", { ascending: false, nullsLast: true })
            .limit(1);

          if (!error && Array.isArray(data) && data.length) {
            statusStr = norm(data[0].status);
            if (ACTIVE_STATUSES.has(statusStr)) ok = true;
          }
        } catch {
          // swallow & continue to team check
        }

        // 2) Team membership (seat access)
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
            }
          } catch {
            // swallow
          }
        }

        if (!cancelled) {
          clearTimeout(timeoutRef.current);
          setAdmit(ok);
          setFoundStatus(statusStr);
          setReason(ok ? "ok" : "no active sub or team");
          setLoading(false);
        }
      } catch {
        if (!cancelled) {
          clearTimeout(timeoutRef.current);
          setAdmit(false);
          setFoundStatus(null);
          setReason("fatal");
          setLoading(false);
        }
      }
    }

    setLoading(true);
    setAdmit(false);
    setFoundStatus(null);
    setReason("");
    safeCheck();

    return () => {
      cancelled = true;
      clearTimeout(timeoutRef.current);
    };
  }, [user?.id]);

  // Small, visible loading (never permanent due to timeout)
  if (loading) {
    return (
      <div className="min-h-[40vh] grid place-items-center bg-neutral-950 text-white/70">
        Checking subscription…
      </div>
    );
  }

  // Allowed → render app
  if (admit) return children;

  // Blocked UI (default, safe fallback)
  return (
    <div className="min-h-[60vh] grid place-items-center bg-neutral-950">
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

          {/* ✅ Open Stripe Checkout directly */}
          <button
            onClick={async () => {
              try {
                const priceId = getPriceId();     // reads VITE_STRIPE_PRICE_ID
                await startCheckout(priceId);      // creates session & redirects
              } catch (e) {
                // Fallback: if env missing, take them to public pricing
                console.warn("startCheckout failed:", e);
                window.location.href = "/#pricing";
              }
            }}
            className="rounded-xl bg-white/10 px-4 py-2 text-sm hover:bg-white/20"
          >
            Subscribe
          </button>
        </div>

        {/* Debug line */}
        <div className="mt-3 text-xs text-white/50">
          {foundStatus ? `Found subscription: ${foundStatus}` : "No subscription found"}
          {reason ? ` • ${reason}` : ""}
        </div>
      </div>
    </div>
  );
}