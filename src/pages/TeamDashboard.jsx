import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { supabase } from "../lib/supabaseClient";
import { getCurrentUserId } from "../lib/teamApi";
import { BarChart3, TrendingUp, Target } from "lucide-react";

export default function TeamDashboard() {
  const { teamId } = useParams();
  const [team, setTeam] = useState(null);
  const [kpis, setKpis] = useState({ leadsThisMonth: 0, apps: 0, policies: 0, premium: 0, conversion: 0 });
  const [leaderboard, setLeaderboard] = useState([]);
  const [loading, setLoading] = useState(true);

  const monthStartISO = useMemo(() => {
    const d = new Date(); d.setDate(1); d.setHours(0,0,0,0); return d.toISOString();
  }, []);

  useEffect(() => {
    (async () => {
      setLoading(true);
      await getCurrentUserId(); // ensure authed

      // Load basic team
      const { data: t, error: tErr } = await supabase
        .from("teams")
        .select("*")
        .eq("id", teamId)
        .single();
      if (tErr) console.warn(tErr);
      setTeam(t || null);

      // --- KPI queries (replace table names as needed) ---
      // These assume you have tables like leads, applications, policies with team_id and user_id.
      // If your schema differs, adjust the selects below.

      // Leads This Month
      const { count: leadsCount } = await supabase
        .from("leads")
        .select("*", { count: "exact", head: true })
        .eq("team_id", teamId)
        .gte("created_at", monthStartISO);

      // Applications submitted
      const { count: appsCount } = await supabase
        .from("applications")
        .select("*", { count: "exact", head: true })
        .eq("team_id", teamId)
        .gte("created_at", monthStartISO);

      // Policies sold + premium
      const { data: policyRows } = await supabase
        .from("policies")
        .select("id, premium, created_at, user_id")
        .eq("team_id", teamId)
        .gte("created_at", monthStartISO);

      const policiesCount = policyRows?.length || 0;
      const premiumSum = (policyRows || []).reduce((a, b) => a + (b.premium || 0), 0);

      // Conversion (policies / leads) simple calc
      const conversion = leadsCount ? Math.round((policiesCount / leadsCount) * 100) : 0;

      setKpis({
        leadsThisMonth: leadsCount || 0,
        apps: appsCount || 0,
        policies: policiesCount,
        premium: premiumSum,
        conversion,
      });

      // Leaderboard by user (policies + premium)
      const byUser = {};
      (policyRows || []).forEach(p => {
        byUser[p.user_id] = byUser[p.user_id] || { user_id: p.user_id, policies: 0, premium: 0 };
        byUser[p.user_id].policies += 1;
        byUser[p.user_id].premium += p.premium || 0;
      });

      // Attach profile names
      const userIds = Object.keys(byUser);
      let profiles = [];
      if (userIds.length) {
        const { data: profs } = await supabase
          .from("profiles")
          .select("id, full_name, email")
          .in("id", userIds);
        profiles = profs || [];
      }
      const rows = Object.values(byUser).map(r => {
        const p = profiles.find(x => x.id === r.user_id);
        return { ...r, name: p?.full_name || r.user_id.slice(0,6), email: p?.email || "—" };
      }).sort((a,b) => b.premium - a.premium);

      setLeaderboard(rows);
      setLoading(false);
    })();
  }, [teamId, monthStartISO]);

  if (loading) return <div className="p-6">Loading...</div>;
  if (!team) return <div className="p-6">Team not found.</div>;

  return (
    <div className="p-6 space-y-8">
      <header>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <BarChart3 className="w-6 h-6" /> {team.name} — Team Dashboard
        </h1>
        <p className="text-sm text-gray-500">Overview of production and activity for this team.</p>
      </header>

      {/* KPI Cards */}
      <section className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard label="Leads (This Month)" value={kpis.leadsThisMonth} icon={<Target className="w-5 h-5" />} />
        <KpiCard label="Applications" value={kpis.apps} icon={<TrendingUp className="w-5 h-5" />} />
        <KpiCard label="Policies Sold" value={kpis.policies} icon={<TrendingUp className="w-5 h-5" />} />
        <KpiCard label="Premium Volume" value={`$${kpis.premium.toLocaleString()}`} icon={<TrendingUp className="w-5 h-5" />} />
      </section>

      {/* Conversion */}
      <section className="border rounded-2xl p-4">
        <div className="text-sm text-gray-600">Conversion Rate</div>
        <div className="text-3xl font-semibold">{kpis.conversion}%</div>
      </section>

      {/* Leaderboard */}
      <section className="border rounded-2xl p-4">
        <div className="font-medium mb-3">Top Producers</div>
        <div className="overflow-auto">
          <table className="min-w-[640px] w-full text-sm">
            <thead className="text-left text-gray-600">
              <tr>
                <th className="py-2 pr-3">Agent</th>
                <th className="py-2 pr-3">Email</th>
                <th className="py-2 pr-3">Policies</th>
                <th className="py-2 pr-3">Premium</th>
              </tr>
            </thead>
            <tbody>
              {leaderboard.map((r) => (
                <tr key={r.user_id} className="border-t">
                  <td className="py-2 pr-3">{r.name}</td>
                  <td className="py-2 pr-3">{r.email}</td>
                  <td className="py-2 pr-3">{r.policies}</td>
                  <td className="py-2 pr-3">${r.premium.toLocaleString()}</td>
                </tr>
              ))}
              {leaderboard.length === 0 && (
                <tr><td className="py-6 text-gray-500">No production yet this month.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function KpiCard({ label, value, icon }) {
  return (
    <div className="border rounded-2xl p-4">
      <div className="text-sm text-gray-600 flex items-center gap-2">{icon} {label}</div>
      <div className="text-2xl font-semibold mt-1">{value}</div>
    </div>
  );
}
