// File: src/pages/TeamDashboard.jsx
import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { supabase } from "../lib/supabaseClient";
import { startOfMonth, endOfMonth } from "../lib/stats.js";
import { BarChart3, TrendingUp, Target } from "lucide-react";

/* ---------- helpers to read sold JSON ---------- */
const PREMIUM_KEYS = ["premium", "monthlyPayment", "annualPremium"];
const MARKED_KEYS  = ["markedAt", "soldAt", "closedAt", "dateMarked"];

function parseNumber(x) {
  if (x == null) return 0;
  if (typeof x === "number") return x;
  const v = parseFloat(String(x).replace(/[$,\s]/g, ""));
  return Number.isFinite(v) ? v : 0;
}
function pickPremium(sold) {
  const s = sold || {};
  for (const k of PREMIUM_KEYS) {
    const v = parseNumber(s[k]);
    if (v > 0) return v;
  }
  return 0;
}
function pickMarkedDate(sold, updated_at, created_at) {
  const s = sold || {};
  for (const k of MARKED_KEYS) if (s[k]) return new Date(s[k]);
  return updated_at ? new Date(updated_at) : new Date(created_at || Date.now());
}

/* ---------- UI bits ---------- */
function KpiCard({ label, value, icon }) {
  return (
    <div className="border rounded-2xl p-4">
      <div className="text-sm text-gray-600 flex items-center gap-2">{icon} {label}</div>
      <div className="text-2xl font-semibold mt-1">{value}</div>
    </div>
  );
}

export default function TeamDashboard() {
  const { teamId } = useParams();
  const [team, setTeam] = useState(null);
  const [kpis, setKpis] = useState({ leadsThisMonth: 0, apps: 0, policies: 0, premium: 0, conversion: 0 });
  const [leaderboard, setLeaderboard] = useState([]);
  const [loading, setLoading] = useState(true);

  const monthStart = useMemo(() => startOfMonth(new Date()), []);
  const monthEnd   = useMemo(() => endOfMonth(new Date()), []);

  useEffect(() => {
    (async () => {
      setLoading(true);

      // 1) Load team
      const { data: t } = await supabase.from("teams").select("*").eq("id", teamId).single();
      setTeam(t || null);

      // 2) Resolve team member IDs (active/invited)
      const { data: ut } = await supabase
        .from("user_teams")
        .select("user_id,status")
        .eq("team_id", teamId);

      const userIds = Array.from(
        new Set(
          (ut || [])
            .filter(r => r.status === "active" || r.status === "invited" || !r.status)
            .map(r => r.user_id)
        )
      );

      if (userIds.length === 0) {
        setKpis({ leadsThisMonth: 0, apps: 0, policies: 0, premium: 0, conversion: 0 });
        setLeaderboard([]);
        setLoading(false);
        return;
      }

      // 3) Leads this month (so far)
      const { count: leadsCount } = await supabase
        .from("leads")
        .select("id", { count: "exact", head: true })
        .in("user_id", userIds)
        .gte("created_at", monthStart.toISOString())
        .lte("created_at", new Date().toISOString());

      // 4) "Applications" KPI from next_follow_up_at (appointments)
      const { count: apptCount } = await supabase
        .from("leads")
        .select("id", { count: "exact", head: true })
        .in("user_id", userIds)
        .not("next_follow_up_at", "is", null)
        .gte("next_follow_up_at", monthStart.toISOString())
        .lte("next_follow_up_at", monthEnd.toISOString());

      // 5) Team SOLD rows — MINIMAL COLUMNS (no client PII)
      const { data: soldRows } = await supabase
        .from("leads")
        .select("id,user_id,company,sold,created_at,updated_at")
        .in("user_id", userIds)
        .eq("status", "sold");

      // Normalize + keep only those whose MARKED date falls in this month
      const soldThisMonth = (soldRows || []).map((r) => {
        const marked = pickMarkedDate(r.sold, r.updated_at, r.created_at);
        return {
          id: r.id,
          user_id: r.user_id,
          premium: pickPremium(r.sold),
          markedAt: marked,
        };
      }).filter((x) => {
        if (!x.markedAt) return false;
        const t = +x.markedAt;
        return t >= +monthStart && t <= +monthEnd;
      });

      const policiesCount = soldThisMonth.length;
      const premiumSum = soldThisMonth.reduce((a, b) => a + (b.premium || 0), 0);
      const conversion = leadsCount ? Math.round((policiesCount / (leadsCount || 1)) * 100) : 0;

      setKpis({
        leadsThisMonth: leadsCount || 0,
        apps: apptCount || 0,
        policies: policiesCount,
        premium: premiumSum,
        conversion,
      });

      // 6) Leaderboard (this-month only; by premium)
      const byUser = {};
      for (const r of soldThisMonth) {
        if (!byUser[r.user_id]) byUser[r.user_id] = { user_id: r.user_id, policies: 0, premium: 0 };
        byUser[r.user_id].policies += 1;
        byUser[r.user_id].premium += r.premium || 0;
      }

      let rows = Object.values(byUser);
      if (rows.length) {
        const { data: profiles } = await supabase
          .from("profiles")
          .select("id,full_name,email")
          .in("id", rows.map((r) => r.user_id));
        const profs = profiles || [];
        rows = rows.map((r) => {
          const p = profs.find((x) => x.id === r.user_id);
          return { ...r, name: p?.full_name || r.user_id.slice(0, 6), email: p?.email || "—" };
        }).sort((a, b) => b.premium - a.premium);
      }
      setLeaderboard(rows);

      setLoading(false);
    })();
  }, [teamId, monthStart, monthEnd]);

  if (loading) return <div className="p-6">Loading...</div>;
  if (!team) return <div className="p-6">Team not found.</div>;

  return (
    <div className="p-6 space-y-8">
      <header>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <BarChart3 className="w-6 h-6" /> {team.name} — Team Dashboard
        </h1>
        <p className="text-sm text-gray-500">This month’s production across all active team members (counted when marked SOLD).</p>
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
        <div className="font-medium mb-3">Top Producers (This Month)</div>
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
