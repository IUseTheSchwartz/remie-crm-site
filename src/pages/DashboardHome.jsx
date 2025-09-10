// File: src/pages/DashboardHome.jsx
import { useEffect, useState } from "react";
import NumberCard from "../components/NumberCard.jsx";
import { dashboardSnapshot, refreshDashboardSnapshot } from "../lib/stats.js";
import { supabase } from "../lib/supabaseClient.js";
import { useAuth } from "../auth.jsx";

function Card({ title, children }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 ring-1 ring-white/5">
      <div className="mb-2 text-sm font-semibold">{title}</div>
      <div className="text-sm text-white/80">{children}</div>
    </div>
  );
}

export default function DashboardHome() {
  const { user } = useAuth();

  // read cached snapshot immediately to avoid layout shift
  const [snap, setSnap] = useState(dashboardSnapshot());
  const [loading, setLoading] = useState(false);

  async function doRefresh(reason = "mount") {
    try {
      setLoading(true);
      const options = {
        user_id: user?.id || null,
        team_id: user?.app_metadata?.team_id || null,
      };
      const data = await refreshDashboardSnapshot(options);
      setSnap(data);
      // console.debug("[Dashboard] refreshed:", reason, data);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let isMounted = true;

    // Initial fetch (IMPORTANT: pass options so stats filter by your user/team)
    doRefresh("mount");

    // Realtime subscriptions: refresh on any relevant insert/update
    // We listen to a few likely tables so appointment counts update immediately.
    const WATCH = [
      { table: "leads", events: ["INSERT", "UPDATE"] },
      { table: "appointments", events: ["INSERT", "UPDATE", "DELETE"] },
      { table: "calendar_events", events: ["INSERT", "UPDATE", "DELETE"] },
      { table: "followups", events: ["INSERT", "UPDATE", "DELETE"] },
      { table: "pipeline_followups", events: ["INSERT", "UPDATE", "DELETE"] },
      { table: "pipeline_events", events: ["INSERT", "UPDATE", "DELETE"] },
    ];

    const channels = WATCH.map(({ table, events }) => {
      const ch = supabase.channel(`dash-${table}`);
      events.forEach((evt) => {
        ch.on("postgres_changes", { event: evt, schema: "public", table }, () => {
          if (!isMounted) return;
          doRefresh(`realtime:${table}:${evt}`);
        });
      });
      ch.subscribe((status) => {
        if (status === "CHANNEL_ERROR") {
          console.warn(`[DashboardHome] Realtime channel error for ${table}`);
        }
      });
      return ch;
    });

    // Optional: polling fallback every 60s while testing
    const poll = setInterval(() => {
      if (!isMounted) return;
      doRefresh("poll");
    }, 60000);

    return () => {
      isMounted = false;
      clearInterval(poll);
      channels.forEach((ch) => supabase.removeChannel(ch));
    };
  }, [user?.id, user?.app_metadata?.team_id]); // rerun when identity scope changes

  const money = (n) =>
    Intl.NumberFormat(undefined, {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }).format(n || 0);

  const kpi = [
    { label: "Closed (today)", value: snap.today.closed, sub: `This month: ${snap.thisMonth.closed}` },
    { label: "Clients (today)", value: snap.today.clients, sub: `This month: ${snap.thisMonth.clients}` },
    { label: "Leads (today)", value: snap.today.leads, sub: `This week: ${snap.thisWeek.leads}` },
    { label: "Appointments (today)", value: snap.today.appointments, sub: `This week: ${snap.thisWeek.appointments}` },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div />
        <button
          onClick={() => doRefresh("button")}
          className="rounded-xl px-3 py-2 text-sm bg-white/10 hover:bg-white/15 border border-white/10 text-white"
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        {kpi.map((x) => (
          <NumberCard key={x.label} label={x.label} value={x.value} sublabel={x.sub} />
        ))}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="This Week">
          <div className="grid grid-cols-5 gap-3 text-sm">
            <NumberCard label="Closed" value={snap.thisWeek.closed} />
            <NumberCard label="Clients" value={snap.thisWeek.clients} />
            <NumberCard label="Leads" value={snap.thisWeek.leads} />
            <NumberCard label="Appts" value={snap.thisWeek.appointments} />
            <NumberCard label="Premium" value={money(snap.thisWeek.premium)} />
          </div>
        </Card>
        <Card title="This Month">
          <div className="grid grid-cols-5 gap-3 text-sm">
            <NumberCard label="Closed" value={snap.thisMonth.closed} />
            <NumberCard label="Clients" value={snap.thisMonth.clients} />
            <NumberCard label="Leads" value={snap.thisMonth.leads} />
            <NumberCard label="Appts" value={snap.thisMonth.appointments} />
            <NumberCard label="Premium" value={money(snap.thisMonth.premium)} />
          </div>
        </Card>
      </div>
    </div>
  );
}
