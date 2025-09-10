// File: src/lib/stats.js
// Dashboard + Reports helpers
// - REPORTS: SOLD & Premium from local storage (policy startDate) so it stays synchronous.
// - DASHBOARD: SOLD & Premium from Supabase (filtered by user_id/team_id), using "marked sold" timestamp.
// - Leads: Supabase (leads.created_at) — so far to NOW
// - Appointments: Supabase (leads.next_follow_up_at) — to period end

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
   Date parsing (robust) + normalization
-------------------------------------------------*/
function toDateSafe(d) {
  if (!d) return null;
  if (d instanceof Date) return Number.isFinite(+d) ? d : null;
  const s = String(d).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) { // ISO / YYYY-MM-DD
    const t = new Date(s);
    return Number.isFinite(+t) ? t : null;
  }
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) { // MM/DD/YYYY
    const [m, dd, y] = s.split("/").map(Number);
    const t = new Date(y, m - 1, dd, 12, 0, 0, 0); // local noon to avoid TZ edge
    return Number.isFinite(+t) ? t : null;
  }
  const t = new Date(s);
  return Number.isFinite(+t) ? t : null;
}
function toLocalNoon(dateLike) {
  const d = toDateSafe(dateLike);
  if (!d) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0, 0);
}

/* -----------------------------------------------
   Time helpers
-------------------------------------------------*/
export function startOfDay(d) { const x = new Date(d); x.setHours(0,0,0,0); return x; }
export function endOfDay(d)   { const x = new Date(d); x.setHours(23,59,59,999); return x; }
export function startOfWeek(d){ const x = startOfDay(d); const diff=(x.getDay()+6)%7; x.setDate(x.getDate()-diff); return x; }
export function endOfWeek(d)  { const s = startOfWeek(d); const e = new Date(s); e.setDate(e.getDate()+6); e.setHours(23,59,59,999); return e; }
export function startOfMonth(d){ const x = startOfDay(d); x.setDate(1); return x; }
export function endOfMonth(d) { const s = startOfMonth(d); const e = new Date(s); e.setMonth(e.getMonth()+1); e.setDate(0); e.setHours(23,59,59,999); return e; }
export function fmtDate(d)  { return new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric" }); }
export function fmtMonth(d) { return new Date(d).toLocaleDateString(undefined, { month: "short", year: "numeric" }); }
export function getWeekKey(d){ const b = startOfWeek(toLocalNoon(d) || new Date()); return b.toISOString().slice(0,10); }

/* =====================================================
   SOLD — LOCAL STORAGE (Reports only; policy startDate)
=====================================================*/
export function getSoldEventsFromStorage() {
  const clients = loadClients() || [];
  const sold = clients.filter((c) => c.status === "sold" && c.sold);
  return sold.map((c) => ({
    type: "policy_closed",
    date: c.sold.startDate || new Date().toISOString(), // policy effective date (may be future)
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
   Totals + filters
-------------------------------------------------*/
function countByType(items) {
  const c = { lead: 0, appointment: 0, client_created: 0, policy_closed: 0, premium: 0 };
  for (const it of items || []) {
    c[it.type] = (c[it.type] || 0) + 1;
    if (it.type === "policy_closed") c.premium += parseNumber(it.premium);
  }
  return c;
}
export function getTotals(items = []) {
  const c = countByType(items || []);
  return { leads: c.lead, appointments: c.appointment, clients: c.client_created, closed: c.policy_closed, premium: c.premium };
}
export function filterRange(items = [], from, to) {
  const a = +from, b = +to;
  return (items || []).filter((x) => {
    const td = toLocalNoon(x.date);
    if (!td) return false;
    const t = +td;
    return t >= a && t <= b;
  });
}

/* -----------------------------------------------
   Reports timeline (sync; local)
-------------------------------------------------*/
function timeline(){ return getSoldEventsFromStorage(); }

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
    const d = toLocalNoon(it.date) || new Date();
    const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
    if (!m.has(key)) m.set(key, []);
    m.get(key).push(it);
  }
  return [...m.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([key, arr]) => {
      const monthDate = new Date(`${key}-01T00:00:00`);
      return { key, label: fmtMonth(monthDate), totals: getTotals(arr), sold: soldList(arr), weeks: groupWeeks(arr) };
    });
}

function groupWeeks(items = []) {
  const w = new Map();
  for (const it of (items || [])) {
    const key = getWeekKey(toLocalNoon(it.date) || new Date());
    if (!w.has(key)) w.set(key, []);
    w.get(key).push(it);
  }
  return [...w.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([key, arr]) => ({ key, label: `${fmtDate(key)} wk`, totals: getTotals(arr), sold: soldList(arr), days: groupDays(arr) }));
}

function groupDays(items = []) {
  const d = new Map();
  for (const it of (items || [])) {
    const dd = toLocalNoon(it.date) || new Date();
    const day = dd.toISOString().slice(0, 10);
    if (!d.has(day)) d.set(day, []);
    d.get(day).push(it);
  }
  return [...d.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([key, arr]) => ({ key, label: fmtDate(key), totals: getTotals(arr), sold: soldList(arr) }));
}

/* =====================================================
   DASHBOARD — SOLD from Supabase with user/team scoping
   (Counts by "marked sold" time, not policy start date)
=====================================================*/

const SOLD_TIME_COLS_DASH = [
  "sold_marked_at", "sold_at", "closed_at", "date_marked", "marked_at",
  "updated_at", "created_at"
];
const SOLD_PREMIUM_COLS = [
  "sold_premium", "premium", "monthly_premium", "annual_premium"
];

// Try a single time column; return rows or [] on error.
async function trySoldQuery(col, startISO, endISO, options = {}) {
  try {
    let q = supabase
      .from("leads")
      .select([
        "id", "user_id", "team_id", "status",
        "name", "email", "phone", "carrier",
        ...SOLD_TIME_COLS_DASH,
        ...SOLD_PREMIUM_COLS,
        "sold_start_date", "policy_start_date"
      ].join(","))
      .gte(col, startISO)
      .lte(col, endISO);

    if (options.team_id) q = q.eq("team_id", options.team_id);
    if (options.user_id) q = q.eq("user_id", options.user_id);
    // If a status column exists, restrict to sold-like statuses
    try { q = q.in("status", ["sold", "policy_closed", "closed"]); } catch {}

    const { data, error } = await q;
    if (error) {
      console.warn(`[stats] sold query error on col ${col}:`, error);
      return [];
    }
    return data || [];
  } catch (e) {
    return [];
  }
}

function chooseMarkedDate(row) {
  for (const key of SOLD_TIME_COLS_DASH) {
    if (row[key]) return row[key];
  }
  return new Date().toISOString();
}

function choosePremium(row) {
  for (const key of SOLD_PREMIUM_COLS) {
    const v = parseNumber(row[key]);
    if (v > 0) return v;
  }
  return 0;
}

function mapRowsToEvents(rows = []) {
  return (rows || []).map((r) => ({
    type: "policy_closed",
    date: chooseMarkedDate(r),
    premium: choosePremium(r),
    name: r.name || r.email || r.phone || "Unknown",
    email: r.email || "",
    phone: r.phone || "",
    carrier: r.carrier || "",
    id: r.id
  }));
}

async function fetchSoldEventsSupabase(startISO, endISO, options = {}) {
  // Query each candidate time column and merge results by id.
  const perCol = await Promise.all(
    SOLD_TIME_COLS_DASH.map((col) => trySoldQuery(col, startISO, endISO, options))
  );

  const byId = new Map(); // id -> row
  for (const batch of perCol) {
    for (const r of batch) {
      if (!byId.has(r.id)) byId.set(r.id, r);
      else {
        // Prefer a more specific "sold_marked_at" over generic timestamps
        const cur = byId.get(r.id);
        const order = (row) => SOLD_TIME_COLS_DASH.findIndex(k => !!row[k]);
        if (order(r) < order(cur)) byId.set(r.id, r);
      }
    }
  }
  return mapRowsToEvents([...byId.values()]);
}

/* -----------------------------------------------
   Supabase counts for Leads / Appointments
-------------------------------------------------*/
// Leads (so-far → end = now)
async function countLeadsBetween(startISO, endISO, options = {}) {
  let q = supabase.from("leads")
    .select("id", { count: "exact", head: true })
    .gte("created_at", startISO)
    .lte("created_at", endISO);
  if (options.team_id) q = q.eq("team_id", options.team_id);
  if (options.user_id) q = q.eq("user_id", options.user_id);
  if (options.extraFilters) q = options.extraFilters(q);
  const { count, error } = await q;
  if (error) { console.error("[stats] lead count error:", error); return 0; }
  return count || 0;
}

// Appointments (to end-of-period) — leads.next_follow_up_at
const APPT_SOURCE = { table: "leads", timeCol: "next_follow_up_at" };
async function countAppointmentsBetween(startISO, endISO, options = {}) {
  let q = supabase.from(APPT_SOURCE.table)
    .select("id", { count: "exact", head: true })
    .gte(APPT_SOURCE.timeCol, startISO)
    .lte(APPT_SOURCE.timeCol, endISO)
    .not(APPT_SOURCE.timeCol, "is", null);
  if (options.team_id) q = q.eq("team_id", options.team_id);
  if (options.user_id) q = q.eq("user_id", options.user_id);
  const { count, error } = await q;
  if (error) { console.error("[stats] appt count error:", error); return 0; }
  return count || 0;
}

/* -----------------------------------------------
   Dashboard cache + refresh (SOLD from Supabase)
-------------------------------------------------*/
const ZERO = { leads: 0, appointments: 0, clients: 0, closed: 0, premium: 0 };

let _cache = {
  today: { ...ZERO },
  thisWeek: { ...ZERO },
  thisMonth: { ...ZERO },
  allTime: { ...ZERO },
  _updatedAt: null,
};
export function dashboardSnapshot(){ return _cache; }

export async function refreshDashboardSnapshot(options = {}, now = new Date()) {
  const todayStart = startOfDay(now), todayEnd = endOfDay(now);
  const weekStart  = startOfWeek(now), weekEnd  = endOfWeek(now);
  const monthStart = startOfMonth(now), monthEnd = endOfMonth(now);

  // SOLD events for dashboard: Supabase, scoped
  const [soldToday, soldWeek, soldMonth, soldAll] = await Promise.all([
    fetchSoldEventsSupabase(todayStart.toISOString(), todayEnd.toISOString(), options),
    fetchSoldEventsSupabase(weekStart.toISOString(),  weekEnd.toISOString(),  options),
    fetchSoldEventsSupabase(monthStart.toISOString(), monthEnd.toISOString(), options),
    fetchSoldEventsSupabase("1970-01-01T00:00:00.000Z", "9999-12-31T23:59:59.999Z", options),
  ]);

  const todaySold  = getTotals(soldToday);
  const weekSold   = getTotals(soldWeek);
  const monthSold  = getTotals(soldMonth);
  const allSold    = getTotals(soldAll);

  // Supabase counts for leads & appointments
  const [
    todayLeads, weekLeads, monthLeads, allLeads,
    todayAppts, weekAppts, monthAppts, allAppts,
  ] = await Promise.all([
    countLeadsBetween(todayStart.toISOString(), now.toISOString(), options),
    countLeadsBetween(weekStart.toISOString(),  now.toISOString(), options),
    countLeadsBetween(monthStart.toISOString(), now.toISOString(), options),
    countLeadsBetween("1970-01-01T00:00:00.000Z", now.toISOString(), options),

    countAppointmentsBetween(todayStart.toISOString(), todayEnd.toISOString(), options),
    countAppointmentsBetween(weekStart.toISOString(),  weekEnd.toISOString(),  options),
    countAppointmentsBetween(monthStart.toISOString(), monthEnd.toISOString(), options),
    countAppointmentsBetween("1970-01-01T00:00:00.000Z", "9999-12-31T23:59:59.999Z", options),
  ]);

  _cache = {
    today:     { ...todaySold,  leads: todayLeads, appointments: todayAppts },
    thisWeek:  { ...weekSold,   leads: weekLeads, appointments: weekAppts  },
    thisMonth: { ...monthSold,  leads: monthLeads,appointments: monthAppts },
    allTime:   { ...allSold,    leads: allLeads,  appointments: allAppts   },
    _updatedAt: new Date().toISOString(),
  };

  // Debug: see exactly what the dashboard used
  if (typeof window !== "undefined") {
    window.__statsDebug = {
      soldToday, soldWeek, soldMonth, soldAll,
      snapshot: _cache,
    };
  }

  return _cache;
}

/* -----------------------------------------------
   Helper for ReportsPage
-------------------------------------------------*/
export function monthFromWeekKey(weekKey) {
  const d = new Date(weekKey);
  return d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
}
