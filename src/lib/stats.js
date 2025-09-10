// File: src/lib/stats.js
// Stats + grouping helpers for dashboard and reports.
// Dashboard lead counts come from Supabase (created_at).
// Reports stays synchronous and defaults to SOLD-only timeline so it won't white-screen.

import { supabase } from "../lib/supabaseClient.js";
import { loadClients } from "./storage.js";

/* -----------------------------------------------
   Number parsing
-------------------------------------------------*/
function parseNumber(x) {
  if (x == null) return 0;
  if (typeof x === "number") return x;
  const n = String(x).replace(/[$,\s]/g, "");
  const v = parseFloat(n);
  return Number.isFinite(v) ? v : 0;
}

/* -----------------------------------------------
   SOLD data source (real, from local storage)
-------------------------------------------------*/
export function getSoldEventsFromStorage() {
  const clients = loadClients();
  const sold = clients.filter((c) => c.status === "sold" && c.sold);
  return sold.map((c) => ({
    type: "policy_closed",
    date: c.sold.startDate || new Date().toISOString(),
    premium: parseNumber(c.sold.premium),
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

export function getTotals(items = []) {
  const c = countByType(items || []);
  return {
    leads: c.lead,
    appointments: c.appointment,
    clients: c.client_created,
    closed: c.policy_closed,
    premium: c.premium,
  };
}

export function filterRange(items = [], from, to) {
  const a = +from, b = +to;
  return (items || []).filter((x) => {
    const t = +new Date(x.date);
    return t >= a && t <= b;
  });
}

/* -----------------------------------------------
   Reports timeline (sync)
   - Keep SOLD events so Reports renders without async
-------------------------------------------------*/
function buildSoldTimeline() {
  return getSoldEventsFromStorage();
}

// ✅ restore the old API: Reports calls groupByMonth() with no args
// so we provide a default timeline() that is synchronous.
function timeline() {
  return buildSoldTimeline();
}

/* -----------------------------------------------
   Grouping (Month → Weeks → Days) with SOLD lists
-------------------------------------------------*/
function soldList(items = []) {
  return (items || [])
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
  for (const it of (items || [])) {
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
        sold: soldList(arr),
        weeks: groupWeeks(arr),
      };
    });
}

function groupWeeks(items = []) {
  const w = new Map();
  for (const it of (items || [])) {
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

function groupDays(items = []) {
  const d = new Map();
  for (const it of (items || [])) {
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

/* ===============================================
   SUPABASE COUNTS for DASHBOARD (created_at / start_time)
   - Leads via leads.created_at (existing)
   - Appointments via appointments.start_time (new)
=================================================*/
async function countLeadsBetween(startISO, endISO, options = {}) {
  let q = supabase
    .from("leads")
    .select("*", { count: "exact", head: true })
    .gte("created_at", startISO)
    .lte("created_at", endISO);

  if (options.team_id) q = q.eq("team_id", options.team_id);
  if (options.user_id) q = q.eq("user_id", options.user_id);
  if (options.extraFilters && typeof options.extraFilters === "function") {
    q = options.extraFilters(q);
  }

  const { count, error } = await q;
  if (error) {
    console.error("[stats] Supabase lead count error:", error);
    return 0;
  }
  return count || 0;
}

/**
 * Count appointments between times.
 * Assumes table: `appointments`
 * - datetime column: `start_time`
 * - optional `status` column; rows with status IN ('canceled','no_show') are excluded if present.
 * Filters: team_id / user_id like leads.
 */
async function countAppointmentsBetween(startISO, endISO, options = {}) {
  let q = supabase
    .from("appointments")
    .select("*", { count: "exact", head: true })
    .gte("start_time", startISO)
    .lte("start_time", endISO);

  if (options.team_id) q = q.eq("team_id", options.team_id);
  if (options.user_id) q = q.eq("user_id", options.user_id);
  // If a status column exists, exclude canceled/no_show. If it doesn't, Supabase ignores the filter.
  // (Supabase won't error on `neq` to a missing column in head:true selects; if it does, we catch below.)
  try {
    q = q.neq("status", "canceled").neq("status", "no_show");
  } catch (_) {
    /* no-op */
  }
  if (options.extraApptFilters && typeof options.extraApptFilters === "function") {
    q = options.extraApptFilters(q);
  }

  const { count, error } = await q;
  if (error) {
    console.error("[stats] Supabase appointment count error:", error);
    return 0;
  }
  return count || 0;
}

const ZERO = { leads: 0, appointments: 0, clients: 0, closed: 0, premium: 0 };

let _cache = {
  today: { ...ZERO },
  thisWeek: { ...ZERO },
  thisMonth: { ...ZERO },
  allTime: { ...ZERO },
  _updatedAt: null,
};

export function dashboardSnapshot() {
  return _cache;
}

export async function refreshDashboardSnapshot(options = {}, now = new Date()) {
  const end = now;
  const todayStart = startOfDay(now);
  const weekStart = startOfWeek(now);
  const monthStart = startOfMonth(now);

  // Parallelize all counts
  const [
    todayLeads, weekLeads, monthLeads, allLeads,
    todayAppts, weekAppts, monthAppts, allAppts,
  ] = await Promise.all([
    countLeadsBetween(todayStart.toISOString(), end.toISOString(), options),
    countLeadsBetween(weekStart.toISOString(), end.toISOString(), options),
    countLeadsBetween(monthStart.toISOString(), end.toISOString(), options),
    countLeadsBetween("1970-01-01T00:00:00.000Z", end.toISOString(), options),

    countAppointmentsBetween(todayStart.toISOString(), end.toISOString(), options),
    countAppointmentsBetween(weekStart.toISOString(), end.toISOString(), options),
    countAppointmentsBetween(monthStart.toISOString(), end.toISOString(), options),
    countAppointmentsBetween("1970-01-01T00:00:00.000Z", end.toISOString(), options),
  ]);

  // SOLD timeline (reports still sync)
  const soldTimeline = buildSoldTimeline();

  const dayItems = filterRange(soldTimeline, todayStart, end);
  const weekItems = filterRange(soldTimeline, weekStart, end);
  const monthItems = filterRange(soldTimeline, monthStart, end);
  const todayTotals = getTotals(dayItems);
  const weekTotals = getTotals(weekItems);
  const monthTotals = getTotals(monthItems);
  const allTotals = getTotals(soldTimeline);

  // Inject Supabase counts
  todayTotals.leads = todayLeads;
  weekTotals.leads = weekLeads;
  monthTotals.leads = monthLeads;
  allTotals.leads = allLeads;

  todayTotals.appointments = todayAppts;
  weekTotals.appointments = weekAppts;
  monthTotals.appointments = monthAppts;
  allTotals.appointments = allAppts;

  _cache = {
    today: todayTotals,
    thisWeek: weekTotals,
    thisMonth: monthTotals,
    allTime: allTotals,
    _updatedAt: new Date().toISOString(),
  };

  return _cache;
}

/* -----------------------------------------------
   Helper for Weekly tab label suffix in ReportsPage
-------------------------------------------------*/
export function monthFromWeekKey(weekKey) {
  const d = new Date(weekKey);
  return d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
}
