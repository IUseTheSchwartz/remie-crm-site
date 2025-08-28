// File: src/pages/ReportsPage.jsx
import { useMemo, useState } from "react";
import NumberCard from "../components/NumberCard.jsx";
import { dashboardSnapshot, groupByMonth } from "../lib/stats.js";

function Row({ label, totals }) {
  return (
    <div className="grid grid-cols-5 gap-3 rounded-xl border border-white/10 bg-white/[0.02] p-3 text-sm">
      <div className="font-medium">{label}</div>
      <div className="text-center">{totals.closed}</div>
      <div className="text-center">{totals.clients}</div>
      <div className="text-center">{totals.leads}</div>
      <div className="text-center">{totals.appointments}</div>
    </div>
  );
}

export default function ReportsPage() {
  const [tab, setTab] = useState("monthly"); // 'weekly' | 'monthly' | 'all'
  const snapshot = useMemo(() => dashboardSnapshot(), []);
  const months = useMemo(() => groupByMonth(), []);

  return (
    <div className="space-y-6">
      {/* Tabs */}
      <div className="inline-flex rounded-full border border-white/15 bg-white/5 p-1 text-sm">
        {[
          { id: "weekly", label: "Weekly" },
          { id: "monthly", label: "Monthly" },
          { id: "all", label: "All-time" },
        ].map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`rounded-full px-3 py-1 ${
              tab === t.id ? "bg-white text-black" : "text-white/80"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Summary strip */}
      <div className="grid gap-4 md:grid-cols-4">
        <NumberCard label="Closed" value={snapshot.allTime.closed} />
        <NumberCard label="Clients" value={snapshot.allTime.clients} />
        <NumberCard label="Leads" value={snapshot.allTime.leads} />
        <NumberCard label="Appointments" value={snapshot.allTime.appointments} />
      </div>

      {/* Tables */}
      {tab === "all" && (
        <div className="space-y-3">
          <div className="grid grid-cols-5 gap-3 text-xs uppercase tracking-wide text-white/60">
            <div>Period</div><div className="text-center">Closed</div>
            <div className="text-center">Clients</div>
            <div className="text-center">Leads</div>
            <div className="text-center">Appts</div>
          </div>

          {months.map((m) => (
            <details key={m.key} className="group">
              <summary className="cursor-pointer list-none">
                <Row label={m.label} totals={m.totals} />
              </summary>

              {/* Weeks inside the month */}
              <div className="ml-2 mt-2 space-y-2">
                {m.weeks.map((w) => (
                  <details key={w.key} className="group">
                    <summary className="cursor-pointer list-none">
                      <Row label={`• ${w.label}`} totals={w.totals} />
                    </summary>

                    {/* Days inside the week */}
                    <div className="ml-4 mt-2 space-y-1">
                      {w.days.map((d) => (
                        <Row key={d.key} label={`— ${d.label}`} totals={d.totals} />
                      ))}
                    </div>
                  </details>
                ))}
              </div>
            </details>
          ))}
        </div>
      )}

      {tab === "monthly" && (
        <div className="space-y-3">
          <div className="grid grid-cols-5 gap-3 text-xs uppercase tracking-wide text-white/60">
            <div>Month</div><div className="text-center">Closed</div>
            <div className="text-center">Clients</div>
            <div className="text-center">Leads</div>
            <div className="text-center">Appts</div>
          </div>
          {months.map((m) => (
            <Row key={m.key} label={m.label} totals={m.totals} />
          ))}
        </div>
      )}

      {tab === "weekly" && (
        <div className="space-y-3">
          <div className="grid grid-cols-5 gap-3 text-xs uppercase tracking-wide text-white/60">
            <div>Week</div><div className="text-center">Closed</div>
            <div className="text-center">Clients</div>
            <div className="text-center">Leads</div>
            <div className="text-center">Appts</div>
          </div>
          {months.flatMap((m) => m.weeks).map((w) => (
            <Row key={w.key} label={`${w.label} (${mFromWeek(w.key)})`} totals={w.totals} />
          ))}
        </div>
      )}
    </div>
  );
}

function mFromWeek(weekKey) {
  const d = new Date(weekKey);
  return d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
}
