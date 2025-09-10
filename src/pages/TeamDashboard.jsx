// File: src/pages/TeamDashboard.jsx
import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { supabase } from "../lib/supabaseClient";
import { getCurrentUserId } from "../lib/teamApi";
import { BarChart3, TrendingUp, Target } from "lucide-react";

// small helper
function parseNumber(x) {
  if (x == null) return 0;
  if (typeof x === "number") return x;
  const n = String(x).replace(/[$,\s]/g, "");
  const v = parseFloat(n);
  return Number.isFinite(v) ? v : 0;
}

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

      /* ---------------- Load Team ---------------- */
      const { data: t, error: tErr } = await supabase
        .from("teams")
        .select("*")
        .eq("id", teamId)
        .single();
      if (tErr) console.warn("[TeamDashboard] load team error:", tErr);
      setTeam(t || null);

      /* ---------------- Leads this month ---------------- */
      let leadsCount = 0;
      {
        const { count, error } = await supabase
          .from("leads")
          .select("id", { count: "exact" })
          .eq("team_id", teamId)
          .gte("created_at", monthStartISO)
          .limit(1);
        if (error) console.warn("[TeamDashboard] leads count error:", error);
        leadsCount = count || 0;
      }

      /* ---------------- Applications ---------------- */
      // Try applications table first; if not available, fall back to leads by stage/status
      let appsCount = 0;
      {
        const { count, error } = await supabase
          .from("applications")
          .select("id", { count: "exact" })
          .eq("team_id", teamId)
          .gte("created_at", monthStartISO)
          .limit(1);

        if (!error) {
          appsCount = count || 0;
        } else {
          // Fallback: detect "application" via leads.stage/status
          const { count: fallbackCount, error: fbErr } = await supabase
            .from("leads")
            .select("id", { count: "exact" })
            .eq("team_id", teamId)
            .gte("created_at", monthStartISO)
            .or("stage.eq.application,stage.eq.applications,status.eq.application,status.eq.application_submitted")
            .limit(1);
          if (fbErr) console.warn("[TeamDashboard] apps fallback error:", fbErr);
          appsCount = fallbackCount || 0;
        }
      }

      /* ---------------- Policies sold + premium ---------------- */
      // Prefer sold_at (if your schema has it); otherwise fall back to created_at window.
      let policiesRows = [];
      {
        // First try filtering by sold_at within this month
        const { data: rowsBySoldAt, error: soldAtErr } = await supabase
          .from("leads")
          .select("id,user_id,premium,monthlyPayment,faceAmount,sold_premium,sold_monthly,sold_face,sold,sold_at,created_at")
          .eq("team_id", teamId)
          .or("status.eq.sold,stage.eq.sold")
          .gte("sold_at", monthStartISO);

        if (soldAtErr) console.warn("[TeamDashboard] policies sold_at query error:", soldAtErr);

        if (rowsBySoldAt && rowsBySoldAt.length) {
          policiesRows = rowsBySoldAt;
        } else {
          // Fallback: if no sold_at column/data, count those created this month and marked sold
          const { data: rowsByCreated, error: createdErr } = await supabase
            .from("leads")
            .select("id,user_id,premium,monthlyPayment,faceAmount,sold_premium,sold_monthly,sold_face,sold,sold_at,created_at")
            .eq("team_id", teamId)
            .or("status.eq.sold,stage.eq.sold")
            .gte("created_at", monthStartISO);
          if (createdErr) console.warn("[TeamDashboard] policies created_at fallback error:", createdErr);
          policiesRows = rowsByCreated || [];
        }
      }

      const policiesCount = policiesRows.length;

      // Compute premium from best-available columns on leads
      // Priority: sold_premium -> premium -> monthlyPayment (if you treat it as monthly premium)
      const premiumSum = policiesRows.reduce((acc, r) => {
        const v =
          parseNumber(r.sold_premium) ||
          parseNumber(r.premium) ||
          parseNumber(r.monthlyPayment); // adjust if you prefer annualize monthly, etc.
        return acc + v;
      }, 0);

      /* ---------------- Conversion ---------------- */
      const conversion = leadsCount ? Math.round((policiesCount / leadsCount) * 100) : 0;

      setKpis({
        leadsThisMonth: leadsCount,
        apps: appsCount,
        policies: policiesCount,
        premium: premiumSum,
        conversion,
      });

      /* ---------------- Leaderboard (by user) ---------------- */
      const byUser = {};
      for (const p of policiesRows) {
        const uid = p.user_id || "unknown";
        if (!byUser[uid]) byUser[uid] = { user_id: uid, policies: 0, premium: 0 };
        byUser[uid].policies += 1;
        byUser[uid].premium +=
          parseNumber(p.sold_premium) ||
          parseNumber(p.premium) ||
          parseNumber(p.monthlyPayment);
      }

      const userIds = Object.keys(byUser).filter(Boolean);
      let profiles = [];
      if (userIds.length) {
        const { data: profs, error: profErr } = await supabase
          .from("profiles")
          .select("id, full_name, email")
          .in("id", userIds);
        if (profErr) console.warn("[TeamDashboard] profiles error:", profErr);
        profiles = profs || [];
      }

      const rows = Object.values(byUser)
        .map((r) => {
          const p = profiles.find((x) => x.id === r.user_id);
          return {
            ...r,
            name: p?.full_name || (r.user_id ? r.user_id.slice(0, 6) : "—"),
            email: p?.email || "—",
          };
        })
        .sort((a, b) => b.premium - a.premium);

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
        <KpiCard label="Premium Volume" value={`$${(kpis.premium || 0).toLocaleString()}`} icon={<TrendingUp className="w-5 h-5" />} />
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
                  <td className="py-2 pr-3">${(r.premium || 0).toLocaleString()}</td>
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
