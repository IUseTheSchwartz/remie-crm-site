// File: src/components/SubscriptionGate.jsx
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabaseClient";
import { useAuth } from "../auth"; // ✅ subscribe to global auth state

function isSubscriptionActive(sub) {
  if (!sub) return false;
  const status = (sub.status || "").toLowerCase();
  if (!["active", "trialing"].includes(status)) return false;
  if (!sub.current_period_end) return false;
  const ends = new Date(sub.current_period_end).getTime();
  return Number.isFinite(ends) && ends > Date.now();
}

export default function SubscriptionGate({ children }) {
  const { user, ready } = useAuth();     // ✅ use hydrated auth
  const [loading, setLoading] = useState(true);
  const [sub, setSub] = useState(null);
  const [error, setError] = useState("");
  const nav = useNavigate();

  async function load(u) {
    setError("");
    setLoading(true);
    try {
      if (!u?.id) {
        setSub(null);
        return;
      }
      const { data, error: sErr } = await supabase
        .from("subscriptions")
        .select("status,current_period_end,plan_name,stripe_subscription_id")
        .eq("user_id", u.id)
        .order("current_period_end", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (sErr) throw sErr;
      setSub(data || null);
    } catch (e) {
      console.error("Subscription check failed:", e);
      setError(e.message || "Failed to verify subscription");
      setSub(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // ✅ Wait until auth is hydrated, then load with the real user
    if (!ready) return;
    load(user);

    // Also refresh if auth state changes (e.g., token refresh)
    const { data: subAuth } = supabase.auth.onAuthStateChange((_e, session) => {
      load(session?.user || null);
    });
    return () => subAuth.subscription.unsubscribe();
  }, [ready, user?.id]); // re-run when the signed-in user changes

  // ✅ Hard-coded bypass for your email (unchanged)
  if (user?.email && user.email.toLowerCase() === "jacobprieto@gmail.com") {
    return <>{children}</>;
  }

  if (!ready || loading) {
    return (
      <div className="min-h-[60vh] grid place-items-center bg-neutral-950 text-white">
        <div className="rounded-xl border border-white/10 bg-white/5 px-5 py-3 text-sm text-gray-300">
          Checking subscription…
        </div>
      </div>
    );
  }

  if (isSubscriptionActive(sub)) {
    return <>{children}</>;
  }

  return (
    <div className="min-h-[60vh] bg-neutral-950 text-white grid place-items-center px-4">
      <div className="w-full max-w-2xl rounded-2xl border border-white/10 bg-black/30 shadow-[0_0_0_1px_rgba(255,255,255,0.06)_inset]">
        <div className="p-6 sm:p-8">
          <h2 className="text-2xl font-semibold">Subscribe to access Remie CRM</h2>
          <p className="mt-2 text-gray-400">
            Your account is logged in, but we didn’t find an active subscription for this workspace.
          </p>

          {error ? (
            <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-red-300">
              {error}
            </div>
          ) : null}

          <div className="mt-6 flex flex-wrap gap-3">
            <button
              onClick={() => load(user)}
              className="px-4 py-2 rounded-lg border border-white/15 bg-white/5 hover:bg-white/10 transition"
            >
              Refresh status
            </button>

            {/* Send to pricing on the landing page */}
            <button
              onClick={() => nav("/#pricing")}
              className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 transition"
            >
              Subscribe
            </button>
            {/* Or use a Link if you prefer: <Link to="/#pricing" className="...">Subscribe</Link> */}
          </div>

          <div className="mt-6 text-sm text-gray-400">
            {sub ? (
              <>
                Found subscription:{" "}
                <span className="font-medium text-gray-200">{sub.status}</span>{" "}
                {sub.current_period_end ? (
                  <>until {new Date(sub.current_period_end).toLocaleString()}</>
                ) : null}
              </>
            ) : (
              <>No subscription record on file.</>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
