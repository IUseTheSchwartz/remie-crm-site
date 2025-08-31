// File: src/components/SubscriptionGate.jsx
import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { startCheckout } from "../lib/billing";

function isSubscriptionActive(sub) {
  if (!sub) return false;
  const status = (sub.status || "").toLowerCase();
  if (!["active", "trialing"].includes(status)) return false;
  if (!sub.current_period_end) return false;
  // sub.current_period_end stored as ISO string in webhook
  const ends = new Date(sub.current_period_end).getTime();
  return Number.isFinite(ends) && ends > Date.now();
}

export default function SubscriptionGate({ children }) {
  const [loading, setLoading] = useState(true);
  const [sub, setSub] = useState(null);
  const [error, setError] = useState("");

  async function load() {
    setError("");
    setLoading(true);
    try {
      const { data: u, error: auErr } = await supabase.auth.getUser();
      if (auErr) throw auErr;
      const user = u?.user;
      if (!user?.id) {
        // not logged in -> no gate here; let your route guard handle it
        setSub(null);
        setLoading(false);
        return;
      }

      // Read the most recent subscription row for this user
      const { data, error: sErr } = await supabase
        .from("subscriptions")
        .select("status,current_period_end,plan_name,stripe_subscription_id")
        .eq("user_id", user.id)
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
    load();
    // also refresh on auth state changes (e.g., after login)
    const { data: subAuth } = supabase.auth.onAuthStateChange((_event, _session) => {
      load();
    });
    return () => subAuth.subscription.unsubscribe();
  }, []);

  if (loading) {
    return (
      <div className="p-6">
        <div className="text-sm text-gray-400">Checking subscription…</div>
      </div>
    );
  }

  if (isSubscriptionActive(sub)) {
    return <>{children}</>;
  }

  // Not active -> show gate
  return (
    <div className="p-6 max-w-2xl">
      <h2 className="text-xl font-semibold mb-2">Subscribe to access Remie CRM</h2>
      <p className="text-gray-400 mb-4">
        Your account is logged in, but we didn’t find an active subscription for this workspace.
      </p>

      {error ? (
        <div className="mb-4 rounded-md border border-red-500/30 bg-red-500/10 p-3 text-red-300">
          {error}
        </div>
      ) : null}

      <div className="flex gap-3">
        <button
          className="px-4 py-2 rounded-lg bg-white/10 hover:bg-white/15 transition"
          onClick={load}
        >
          Refresh status
        </button>

        <button
          className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 transition"
          onClick={() => startCheckout(import.meta.env.VITE_STRIPE_PRICE_ID)}
        >
          Subscribe
        </button>
      </div>

      {sub ? (
        <div className="mt-6 text-sm text-gray-400">
          Found subscription: <span className="font-medium text-gray-200">{sub.status}</span>{" "}
          {sub.current_period_end ? (
            <>until {new Date(sub.current_period_end).toLocaleString()}</>
          ) : null}
        </div>
      ) : (
        <div className="mt-6 text-sm text-gray-400">No subscription record on file.</div>
      )}
    </div>
  );
}
