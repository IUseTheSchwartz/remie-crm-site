// File: src/lib/stats.js
// Stats + grouping helpers for dashboard and reports.
// Combines demo "activity" for leads/appointments with real SOLD data from storage.

import { loadClients } from "./storage.js";

/* -----------------------------------------------
   SOLD data source (real, from local storage)
   We use sold.startDate as the event date and sold.premium for sums.
-------------------------------------------------*/
function parseNumber(x) {
  if (x == null) return 0;
  if (typeof x === "number") return x;
  // remove $ , and spaces
  const n = String(x).replace(/[$,\s]/g, "");
  const v = parseFloat(n);
  return Number.isFinite(v) ? v : 0;
}

export function getSoldEventsFromStorage() {
  const clients = loadClients();
  const sold = clients.filter((c) => c.status === "sold" && c.sold);
  return sold.map((c) => ({
    type: "policy_closed",
    date: c.sold.startDate || new Date().toISOString(),
    premium: parseNumber(c.sold.premium), // one-time or annual premium you recorded
    name: c.sold.name || c.name || "",
    email: c.sold.email || c.email || "",
    phone: c.sold.phone || c.phone || "",
    carrier: c.sold.carrier || "",
    monthlyPayment: parseNumber(c.sold.monthlyPayment),
    faceAmount: parseNumber(c.sold.faceAmount),
    id: c.id,
  }));
}

/* -----------------------------------------------
   DEMO activity (optional). Leave empty to avoid fake numbers.
   If you still want demo leads/appointments, you can re-add a generator.
-------------------------------------------------*/
const MOCK = []; // keep empty so nothing shows unless you import/save data

/* -----------------------------------------------
   Time helpers
-------------------------------------------------*/
export function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
export function startOfWeek(d) {
  const x = startOfDay(d);
  const day = x.getDay(); // 0=Sun
  const diff = (day + 6) % 7; // Monday start
  x.setDate(x.getDate() - diff);
  return x;
}
export function startOfMonth(d) {
  const x = startOfDay(d);
  x.setDate(1);
  return x;
}
export function fmtDate(d) {
  return new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
export function fmtMonth(d) {
  return new Date(d).toLocaleDateString(undefined, { month: "short", year: "numeric" });
}
export function getWeekKey(d) {
  const base = startOfWeek(new Date(d));
  return base.toISOString().slice(0, 10); // YYYY-MM-DD (Mon)
}

/* -----------------------------------------------
   Totals + filters
-------------------------------------------------*/
function countByType(items) {
  const c = { lead: 0, appointment: 0, client_created: 0, policy_closed: 0, premium: 0 };
  for (const it of items) {
    c[it.type] = (c[it.type] || 0) + 1;
    if (it.type === "policy_closed") c.premium += parseNumber(it.premium);
  }
  return c;
}

export function getTotals(items) {
  const c = countByType(items);
  return {
    leads: c.lead,
    appointments: c.appointment,
    clients: c.client_created,
    closed: c.policy_closed,
    premium: c.premium, // NEW
  };
}

export function filterRange(items, from, to) {
  const a = +from, b = +to;
  return items.filter((x) => {
    const t = +new Date(x.date);
    return t >= a && t <= b;
  });
}

/* -----------------------------------------------
   Combine sources for a single timeline
   - MOCK (optional) for leads/appointments
   - SOLD (real) for policy_closed + premium
-------------------------------------------------*/
function timeline() {
  const sold = getSoldEventsFromStorage();
  return [...MOCK, ...sold];
}

/* -----------------------------------------------
   Grouping (Month → Weeks → Days) with SOLD lists
-------------------------------------------------*/
function soldList(items) {
  return items
    .filter((x) => x.type === "policy_closed")
    .map((x) => ({
      id: x.id,
      name: x.name || x.email || x.phone || "Unknown",
      premium: parseNumber(x.premium),
      carrier: x.carrier || "",
      date: x.date,
    }));
}

export function groupByMonth(items = timeline()) {
  const m = new Map();
  for (const it of items) {
    const d = new Date(it.date);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    if (!m.has(key)) m.set(key, []);
    m.get(key).push(it);
  }
  return [...m.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([key, arr]) => {
      const monthDate = new Date(`${key}-01T00:00:00`);
      return {
        key,
        label: fmtMonth(monthDate),
        totals: getTotals(arr),
        sold: soldList(arr), // list of sold clients in this month
        weeks: groupWeeks(arr),
      };
    });
}

function groupWeeks(items) {
  const w = new Map();
  for (const it of items) {
    const key = getWeekKey(it.date); // Monday start
    if (!w.has(key)) w.set(key, []);
    w.get(key).push(it);
  }
  return [...w.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([key, arr]) => ({
      key,
      label: `${fmtDate(key)} wk`,
      totals: getTotals(arr),
      sold: soldList(arr),
      days: groupDays(arr),
    }));
}

function groupDays(items) {
  const d = new Map();
  for (const it of items) {
    const day = new Date(it.date).toISOString().slice(0, 10);
    if (!d.has(day)) d.set(day, []);
    d.get(day).push(it);
  }
  return [...d.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([key, arr]) => ({
      key,
      label: fmtDate(key),
      totals: getTotals(arr),
      sold: soldList(arr),
    }));
}

/* -----------------------------------------------
   Dashboard snapshot (Today / This Week / This Month / All-time)
-------------------------------------------------*/
export function dashboardSnapshot(now = new Date(), items = timeline()) {
  const today = startOfDay(now);
  const weekStart = startOfWeek(now);
  const monthStart = startOfMonth(now);

  const dayItems = filterRange(items, today, now);
  const weekItems = filterRange(items, weekStart, now);
  const monthItems = filterRange(items, monthStart, now);

  return {
    today: getTotals(dayItems),
    thisWeek: getTotals(weekItems),
    thisMonth: getTotals(monthItems),
    allTime: getTotals(items),
  };
}

// Helper for Weekly tab label suffix in ReportsPage
export function monthFromWeekKey(weekKey) {
  const d = new Date(weekKey);
  return d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
}
