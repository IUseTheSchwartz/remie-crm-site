// File: src/components/SubscriptionGate.jsx
import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabaseClient";

/**
 * What counts as active?
 * - status: 'active' or 'trialing'
 * - current_period_end is in the future (still within the paid/trial period)
 * Adjust if you want to allow 'past_due' etc.
 */
function isSubscriptionActive(sub) {
  if (!sub) return false;
  const okStatus = ["active", "trialing"].includes((sub.status || "").toLowerCase());
  if (!okStatus) return false;
  const end = sub.current_period_end ? new Date(sub.current_period_end).getTime() : 0;
  return end > Date.now();
}

/**
 * Wrap any gated content with this component.
 * If user is not signed in => it just renders children (ProtectedRoute should handle auth).
 * If signed in but no active subscription => shows a paywall and link to /subscribe
 */
export default function SubscriptionGate({ children }) {
  const [loading, setLoading] = useState(true);
  const [sub, setSub] = useState(null);
  const [userId, setUserId] = useState(null);

  const nav = useNavigate();
  const loc = useLocation();

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setLoading(true);
      try {
        const { data, error } = await supabase.auth.getUser();
        if (error) throw error;

        const uid = data?.user?.id || null;
        if (!uid) {
          // Not signed in — let ProtectedRoute handle redirect. We just stop loading.
          if (!cancelled) {
            setUserId(null);
            setSub(null);
            setLoading(false);
          }
          return;
        }

        setUserId(uid);

        // Pull most recent subscription for this user
        const { data: sData, error: sErr } = await supabase
          .from("subscriptions")
          .select("*")
          .eq("user_id", uid)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (sErr) {
          console.warn("subscriptions query failed:", sErr);
        }
        if (!cancelled) {
          setSub(sData || null);
        }
      } catch (e) {
        console.error(e);
        if (!cancelled) {
          setSub(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [loc.key]); // recheck on route change

  if (loading) {
    return (
      <div className="p-6 text-sm text-white/70">
        Checking subscription…
      </div>
    );
  }

  // If user not logged in, let ProtectedRoute redirect — render children so layout doesn't jump.
  if (!userId) {
    return <>{children}</>;
  }

  if (!isSubscriptionActive(sub)) {
    return (
      <div className="mx-auto max-w-xl p-6">
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 ring-1 ring-white/5 text-white">
          <h1 className="text-xl font-semibold">Subscription required</h1>
          <p className="mt-2 text-sm text-white/70">
            You need an active plan to access this part of Remie CRM.
          </p>
          <div className="mt-5 flex flex-wrap gap-3">
            <Link
              to="/subscribe"
              className="rounded-xl bg-white px-4 py-2 text-sm font-medium text-black hover:bg-neutral-200"
            >
              See plans & subscribe
            </Link>
            <Link
              to="/app/settings"
              className="rounded-xl border border-white/15 px-4 py-2 text-sm hover:bg-white/5"
            >
              Manage account
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // Good to go
  return <>{children}</>;
}
