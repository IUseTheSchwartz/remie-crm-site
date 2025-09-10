// File: src/pages/TeamDashboard.jsx
import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabaseClient.js";
import { useAuth } from "../auth.jsx";
import NumberCard from "../components/NumberCard.jsx";
import { dashboardSnapshot, refreshDashboardSnapshot } from "../lib/stats.js";

function Card({ title, children }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 ring-1 ring-white/5">
      <div className="mb-2 text-sm font-semibold">{title}</div>
      <div className="text-sm text-white/80">{children}</div>
    </div>
  );
}

export default function TeamDashboard() {
  const { user } = useAuth();
  const [teams, setTeams] = useState([]);
  const [teamId, setTeamId] = useState(null);
  const [snap, setSnap] = useState(dashboardSnapshot());
  const [loading, setLoading] = useState(true);

  // Load teams the user belongs to
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!user?.id) return;
      setLoading(true);
      // Try membership table that joins to teams
      // Adjust table/column names if yours differ.
      const { data, error } = await supabase
        .from("team_members")
        .select(`
          team_id,
          teams!inner(id, name)
        `)
        .eq("user_id", user.id);

      if (!alive) return;

      if (error) {
        console.error("[TeamDashboard] load teams error:", error);
        setTeams([]);
        setTeamId(null);
      } else {
        const list = (data || []).map((r) => ({ id: r.team_id, name: r.teams?.name || "Team" }));
        setTeams(list);
        setTeamId((prev) => prev || list[0]?.id || null);
      }
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [user?.id]);

  // Refresh stats for the selected team (IMPORTANT: no user_id here)
  async function doRefresh(reason = "mount") {
    if (!teamId) return;
    setLoading(true);
    try {
      const s = await refreshDashboardSnapshot({ team_id: teamId });
      setSnap({ ...s });
      // console.debug("[TeamDashboard] refreshed:", reason, s);
    } finally {
      setLoading(false);
    }
  }

  // Initial + on team change
  useEffect(() => {
    if (!teamId) return;
    let alive = true;
    (async () => {
      await doRefresh("team-change");
    })();

    // Realtime refresh when leads change for any teammate
    const ch = supabase
      .channel(`team-dash-${teamId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "leads" }, () => {
        // We don’t filter server-side; simply refresh on any change.
        doRefresh("realtime:leads");
      })
      .subscribe();

    // Polling fallback (optional)
    const poll = setInterval(() => doRefresh("poll"), 60000);

    return () => {
      supabase.removeChannel(ch);
      clearInterval(poll);
      alive = false;
    };
  }, [teamId]);

  const money = (n) =>
    Intl.NumberFormat(undefined, {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }).format(n || 0);

  const teamName = useMemo(
    () => teams.find((t) => t.id === teamId)?.name || "My Team",
    [teams, teamId]
  );

  const kpi = [
    { label: "Closed (today)", value: snap.today.closed, sub: `This month: ${snap.thisMonth.closed}` },
    { label: "Clients (today)", value: snap.today.clients, sub: `This month: ${snap.thisMonth.clients}` },
    { label: "Leads (today)", value: snap.today.leads, sub: `This week: ${snap.thisWeek.leads}` },
    { label: "Appointments (today)", value: snap.today.appointments, sub: `This week: ${snap.thisWeek.appointments}` },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-white">Team Dashboard — {teamName}</h1>

        <div className="flex items-center gap-2">
          <select
            value={teamId || ""}
            onChange={(e) => setTeamId(e.target.value || null)}
            className="bg-white/10 border border-white/10 rounded-xl px-3 py-2 text-sm text-white"
          >
            {teams.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
          <button
            onClick={() => doRefresh("button")}
            className="rounded-xl px-3 py-2 text-sm bg-white/10 hover:bg-white/15 border border-white/10 text-white"
          >
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
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
