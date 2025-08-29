// File: src/pages/ReportsPage.jsx
import { useMemo, useState } from "react";
import NumberCard from "../components/NumberCard.jsx";
import { dashboardSnapshot, groupByMonth, monthFromWeekKey } from "../lib/stats.js";

function Row({ label, totals, onClick }) {
  return (
    <button
      onClick={onClick}
      className="grid w-full grid-cols-6 gap-3 rounded-xl border border-white/10 bg-white/[0.02] p-3 text-left text-sm hover:bg-white/[0.06]"
    >
      <div className="font-medium">{label}</div>
      <div className="text-center">{totals.closed}</div>
      <div className="text-center">{formatMoney(totals.premium)}</div>
      <div className="text-center">{totals.clients}</div>
      <div className="text-center">{totals.leads}</div>
      <div className="text-center">{totals.appointments}</div>
    </button>
  );
}

function formatMoney(n) {
  return Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n || 0);
}

export default function ReportsPage() {
  const [tab, setTab] = useState("monthly"); // 'weekly' | 'monthly' | 'all'
  const [expanded, setExpanded] = useState(null); // { level:'month'|'week'|'day'|'all', key:string }

  const snapshot = useMemo(() => dashboardSnapshot(), []);
  const months = useMemo(() => groupByMonth(), []);

  // For Weekly tab we flatten weeks across months
  const allWeeks = useMemo(() => months.flatMap((m) => m.weeks), [months]);

  // For All-time list (top-level rows are months; inside we also show weeks & days)
  const allTimeMonths = months;

  const header = (
    <div className="grid grid-cols-6 gap-3 text-xs uppercase tracking-wide text-white/60">
      <div>Period</div>
      <div className="text-center">Closed</div>
      <div className="text-center">Premium</div>
      <div className="text-center">Clients</div>
      <div className="text-center">Leads</div>
      <div className="text-center">Appts</div>
    </div>
  );

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
            onClick={() => { setTab(t.id); setExpanded(null); }}
            className={`rounded-full px-3 py-1 ${tab === t.id ? "bg-white text-black" : "text-white/80"}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Summary strip */}
      <div className="grid gap-4 md:grid-cols-4">
        <NumberCard label="Closed (all time)" value={snapshot.allTime.closed} />
        <NumberCard label="Premium (all time)" value={formatMoney(snapshot.allTime.premium)} />
        <NumberCard label="Closed (this month)" value={snapshot.thisMonth.closed} />
        <NumberCard label="Premium (this month)" value={formatMoney(snapshot.thisMonth.premium)} />
      </div>

      {/* Tables */}
      {tab === "monthly" && (
        <div className="space-y-3">
          {header}
          {months.map((m) => (
            <div key={m.key} className="space-y-2">
              <Row
                label={m.label}
                totals={m.totals}
                onClick={() => setExpanded((e) => (e?.key === m.key ? null : { level: "month", key: m.key }))}
              />
              {expanded?.level === "month" && expanded?.key === m.key && (
                <div className="ml-2 space-y-2">
                  {/* SOLD list summary for the month */}
                  <SoldList title="Sold in this month" items={m.sold} />
                  {/* Weeks */}
                  {m.weeks.map((w) => (
                    <div key={w.key} className="ml-2">
                      <Row
                        label={`• ${w.label}`}
                        totals={w.totals}
                        onClick={() => setExpanded((e) =>
                          e?.key === w.key ? { level: "month", key: m.key } : { level: "week", key: w.key }
                        )}
                      />
                      {expanded?.level === "week" && expanded?.key === w.key && (
                        <div className="ml-4 space-y-1">
                          <SoldList title="Sold in this week" items={w.sold} />
                          {w.days.map((d) => (
                            <div key={d.key} className="ml-2">
                              <Row
                                label={`— ${d.label}`}
                                totals={d.totals}
                                onClick={() => setExpanded((e) =>
                                  e?.key === d.key ? { level: "week", key: w.key } : { level: "day", key: d.key }
                                )}
                              />
                              {expanded?.level === "day" && expanded?.key === d.key && (
                                <div className="ml-6">
                                  <SoldList title="Sold on this day" items={d.sold} />
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {tab === "weekly" && (
        <div className="space-y-3">
          {header}
          {allWeeks.map((w) => (
            <div key={w.key} className="space-y-2">
              <Row
                label={`${w.label} (${monthFromWeekKey(w.key)})`}
                totals={w.totals}
                onClick={() => setExpanded((e) => (e?.key === w.key ? null : { level: "week", key: w.key }))}
              />
              {expanded?.level === "week" && expanded?.key === w.key && (
                <div className="ml-4 space-y-2">
                  <SoldList title="Sold in this week" items={w.sold} />
                  {/* Show days for this week */}
                  {w.days.map((d) => (
                    <div key={d.key} className="ml-2">
                      <Row
                        label={`— ${d.label}`}
                        totals={d.totals}
                        onClick={() => setExpanded((e) =>
                          e?.key === d.key ? { level: "week", key: w.key } : { level: "day", key: d.key }
                        )}
                      />
                      {expanded?.level === "day" && expanded?.key === d.key && (
                        <div className="ml-6">
                          <SoldList title="Sold on this day" items={d.sold} />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {tab === "all" && (
        <div className="space-y-3">
          {header}
          {allTimeMonths.map((m) => (
            <div key={m.key} className="space-y-2">
              <Row
                label={m.label}
                totals={m.totals}
                onClick={() => setExpanded((e) => (e?.key === m.key ? null : { level: "month", key: m.key }))}
              />
              {expanded?.level === "month" && expanded?.key === m.key && (
                <div className="ml-2 space-y-2">
                  <SoldList title="Sold in this month" items={m.sold} />
                  {m.weeks.map((w) => (
                    <div key={w.key} className="ml-2">
                      <Row
                        label={`• ${w.label}`}
                        totals={w.totals}
                        onClick={() => setExpanded((e) =>
                          e?.key === w.key ? { level: "month", key: m.key } : { level: "week", key: w.key }
                        )}
                      />
                      {expanded?.level === "week" && expanded?.key === w.key && (
                        <div className="ml-4 space-y-1">
                          <SoldList title="Sold in this week" items={w.sold} />
                          {w.days.map((d) => (
                            <div key={d.key} className="ml-2">
                              <Row
                                label={`— ${d.label}`}
                                totals={d.totals}
                                onClick={() => setExpanded((e) =>
                                  e?.key === d.key ? { level: "week", key: w.key } : { level: "day", key: d.key }
                                )}
                              />
                              {expanded?.level === "day" && expanded?.key === d.key && (
                                <div className="ml-6">
                                  <SoldList title="Sold on this day" items={d.sold} />
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SoldList({ title, items }) {
  const total = items.reduce((s, x) => s + (x.premium || 0), 0);
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
      <div className="mb-2 text-sm font-semibold">
        {title} — Premium: {formatMoney(total)} ({items.length} policies)
      </div>
      {items.length === 0 ? (
        <div className="text-sm text-white/60">No sold clients in this period.</div>
      ) : (
        <ul className="space-y-1 text-sm">
          {items.map((x) => (
            <li key={x.id} className="flex items-center justify-between rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2">
              <span className="truncate">
                {x.name} <span className="text-white/50">({x.carrier || "Carrier N/A"})</span>
              </span>
              <span className="tabular-nums">{formatMoney(x.premium)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
