// File: src/components/SubscriptionGate.jsx
import { useEffect, useState } from "react";
import { supabase } from "../supabaseClient";

export default function SubscriptionGate({ children }) {
  const [state, setState] = useState({ loading: true, active: false });

  useEffect(() => {
    let alive = true;
    async function load() {
      const { data: u } = await supabase.auth.getUser();
      const userId = u?.user?.id;
      if (!userId) { alive && setState({ loading: false, active: false }); return; }
      const { data } = await supabase
        .from("subscriptions")
        .select("status")
        .eq("user_id", userId)
        .maybeSingle();
      const active = data && ["active", "trialing", "past_due"].includes(data.status);
      if (alive) setState({ loading: false, active: !!active });
    }
    load();
    const { data: sub } = supabase.auth.onAuthStateChange(() => load());
    return () => { alive = false; sub?.subscription?.unsubscribe?.(); };
  }, []);

  if (state.loading) {
    return <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">Checking subscription…</div>;
  }
  if (!state.active) {
    return (
      <div className="rounded-2xl border border-rose-500/30 bg-rose-500/10 p-4">
        <div className="text-sm">
          You need an <strong>active subscription</strong> to use the app.
        </div>
        <div className="mt-2 flex gap-2">
          <a href="/" className="rounded-xl bg-white px-3 py-2 text-sm text-black">Choose a plan</a>
          <a href="/app/settings" className="rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-sm">Billing & status</a>
        </div>
      </div>
    );
  }
  return children;
}
