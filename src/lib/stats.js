// File: src/lib/stats.js

// ---- MOCK ACTIVITY DATA (replace with Supabase later) ----
// Each item has a `type` and a `date` (ISO string).
// types: "lead", "appointment", "client_created", "policy_closed"
const MOCK = (() => {
  const types = ["lead", "appointment", "client_created", "policy_closed"];
  const now = new Date();
  const daysBack = 200;
  const out = [];
  for (let i = 0; i < 800; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - Math.floor(Math.random() * daysBack));
    const t = types[Math.floor(Math.random() * types.length)];
    out.push({ type: t, date: d.toISOString() });
  }
  return out;
})();

// ---- DATE HELPERS (no external deps) ----
export function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
export function startOfWeek(d) {
  const x = startOfDay(d);
  const day = x.getDay(); // 0=Sun
  const diff = (day + 6) % 7; // make Monday start
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

// ---- AGGREGATION ----
function countByType(items) {
  const c = { lead: 0, appointment: 0, client_created: 0, policy_closed: 0 };
  for (const it of items) c[it.type] = (c[it.type] || 0) + 1;
  return c;
}

export function getTotals(items = MOCK) {
  const c = countByType(items);
  return {
    leads: c.lead,
    appointments: c.appointment,
    clients: c.client_created,
    closed: c.policy_closed,
  };
}

export function filterRange(items, from, to) {
  const a = +from, b = +to;
  return items.filter((x) => {
    const t = +new Date(x.date);
    return t >= a && t <= b;
  });
}

export function groupByMonth(items = MOCK) {
  const m = new Map();
  for (const it of items) {
    const d = new Date(it.date);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    if (!m.has(key)) m.set(key, []);
    m.get(key).push(it);
  }
  // return newest first
  return [...m.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([key, arr]) => ({
      key,
      label: fmtMonth(new Date(`${key}-01T00:00:00`)),
      totals: getTotals(arr),
      weeks: groupWeeks(arr),
    }));
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
    }));
}

// High-level helpers for dashboard cards
export function dashboardSnapshot(now = new Date(), items = MOCK) {
  const today = startOfDay(now);
  const weekStart = startOfWeek(now);
  const monthStart = startOfMonth(now);

  const dayItems = filterRange(items, today, now);
  const weekItems = filterRange(items, weekStart, now);
  const monthItems = filterRange(items, monthStart, now);
  const allTotals = getTotals(items);

  return {
    today: getTotals(dayItems),
    thisWeek: getTotals(weekItems),
    thisMonth: getTotals(monthItems),
    allTime: allTotals,
  };
}

/* --------------------- SUPABASE NOTES ----------------------
Later, replace MOCK & readers with real queries. Example:

import { supabase } from "../supabaseClient";

// table: activity (id, user_id, type, occurred_at TIMESTAMP)
// types: 'lead' | 'appointment' | 'client_created' | 'policy_closed'
export async function fetchActivityForUser(userId, since, until) {
  let q = supabase.from('activity').select('*').eq('user_id', userId);
  if (since) q = q.gte('occurred_at', since.toISOString());
  if (until) q = q.lte('occurred_at', until.toISOString());
  const { data, error } = await q;
  if (error) throw error;
  return data.map(r => ({ type: r.type, date: r.occurred_at }));
}

---------------------------------------------------------------- */
