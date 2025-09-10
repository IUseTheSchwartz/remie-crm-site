// File: src/lib/stats.js
// Dashboard + Reports helpers
// - DASHBOARD: SOLD & Premium from Supabase (status='sold'), scoped by user/team, counted by "marked sold" time.
// - REPORTS: SOLD & Premium can come from Supabase (policy start date) via fetchReportsSoldTimeline(options).
//            (Legacy local-storage helpers kept for compatibility with old code.)
//
// - Leads: Supabase (leads.created_at) — to NOW
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

/* ========== LEGACY (LOCAL) SOLD for Reports compatibility ========== */
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
   Grouping (works for any items array of events)
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

export function groupByMonth(items = []) {
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
   DASHBOARD — SOLD from Supabase (status='sold'), scoped
   Count by "marked sold" time (sold.* timestamp or updated_at)
=====================================================*/
const SOLD_JSON_TIME_KEYS = ["markedAt", "soldAt", "closedAt", "dateMarked"]; // for marked-sold
const SOLD_JSON_PREMIUM_KEYS = ["premium", "monthlyPayment", "annualPremium"]; // premium fields
const SOLD_JSON_POLICY_DATE_KEYS = ["startDate", "policy_start_date", "policyStartDate", "effectiveDate", "policyEffectiveDate"]; // for Reports

/** Get team user IDs for scoping (user_teams). */
async function fetchTeamUserIds(team_id) {
  const { data, error } = await supabase
    .from("user_teams")
    .select("user_id")
    .eq("team_id", team_id)
    .eq("status", "active");

  if (error) {
    console.warn("[stats] fetchTeamUserIds error:", error);
    return [];
  }
  return (data || []).map((r) => r.user_id);
}

/** Choose timestamps/premium from a row.sold JSON */
function chooseMarkedDateFromRow(row) {
  const s = row?.sold || {};
  for (const k of SOLD_JSON_TIME_KEYS) if (s && s[k]) return s[k];
  if (row.updated_at) return row.updated_at;
  return row.created_at || new Date().toISOString();
}
function choosePolicyDateFromRow(row) {
  const s = row?.sold || {};
  for (const k of SOLD_JSON_POLICY_DATE_KEYS) if (s && s[k]) return s[k];
  // Fallback so it still appears if policy date missing
  return row.updated_at || row.created_at || new Date().toISOString();
}
function choosePremiumFromRow(row) {
  const s = row?.sold || {};
  for (const k of SOLD_JSON_PREMIUM_KEYS) {
    const v = parseNumber(s[k]);
    if (v > 0) return v;
  }
  return 0;
}

/** Fetch sold leads rows for a window (Dashboard), scoped by user/team; map to events by MARKED date. */
async function fetchSoldEventsSupabaseMarked(startISO, endISO, options = {}) {
  let userIds = null;
  if (options.user_id) userIds = [options.user_id];
  else if (options.team_id) userIds = await fetchTeamUserIds(options.team_id);

  let q = supabase
    .from("leads")
    .select("id,user_id,status,updated_at,created_at,sold,name,email,phone,company")
    .eq("status", "sold")
    .gte("updated_at", startISO)
    .lte("updated_at", endISO);

  if (Array.isArray(userIds) && userIds.length > 0) {
    q = userIds.length === 1 ? q.eq("user_id", userIds[0]) : q.in("user_id", userIds);
  }

  const { data, error } = await q;
  if (error) {
    console.error("[stats] fetchSoldEventsSupabaseMarked error:", error);
    return [];
  }
  return (data || []).map((r) => ({
    type: "policy_closed",
    date: chooseMarkedDateFromRow(r),
    premium: choosePremiumFromRow(r),
    name: r.name || r.email || r.phone || "Unknown",
    email: r.email || "",
    phone: r.phone || "",
    carrier: r.company || "",
    id: r.id,
  }));
}

/** PUBLIC: Fetch ALL sold leads for Reports (scoped), mapped by POLICY start date. */
export async function fetchReportsSoldTimeline(options = {}) {
  let userIds = null;
  if (options.user_id) userIds = [options.user_id];
  else if (options.team_id) userIds = await fetchTeamUserIds(options.team_id);

  let q = supabase
    .from("leads")
    .select("id,user_id,status,updated_at,created_at,sold,name,email,phone,company")
    .eq("status", "sold");

  if (Array.isArray(userIds) && userIds.length > 0) {
    q = userIds.length === 1 ? q.eq("user_id", userIds[0]) : q.in("user_id", userIds);
  }

  const { data, error } = await q;
  if (error) {
    console.error("[stats] fetchReportsSoldTimeline error:", error);
    return [];
  }

  return (data || [])
    .map((r) => ({
      type: "policy_closed",
      date: choosePolicyDateFromRow(r), // POLICY start date for Reports
      premium: choosePremiumFromRow(r),
      name: r.name || r.email || r.phone || "Unknown",
      email: r.email || "",
      phone: r.phone || "",
      carrier: r.company || "",
      id: r.id,
    }))
    // guard against completely missing dates
    .filter((e) => !!toLocalNoon(e.date));
}

/* -----------------------------------------------
   Supabase counts for Leads / Appointments
-------------------------------------------------*/
async function countLeadsBetween(startISO, endISO, options = {}) {
  let q = supabase.from("leads")
    .select("id", { count: "exact", head: true })
    .gte("created_at", startISO)
    .lte("created_at", endISO);

  if (options.user_id) {
    q = q.eq("user_id", options.user_id);
  } else if (options.team_id) {
    const userIds = await fetchTeamUserIds(options.team_id);
    if (userIds.length === 0) return 0;
    q = q.in("user_id", userIds);
  }

  const { count, error } = await q;
  if (error) { console.error("[stats] lead count error:", error); return 0; }
  return count || 0;
}

const APPT_SOURCE = { table: "leads", timeCol: "next_follow_up_at" };
async function countAppointmentsBetween(startISO, endISO, options = {}) {
  let q = supabase.from(APPT_SOURCE.table)
    .select("id", { count: "exact", head: true })
    .gte(APPT_SOURCE.timeCol, startISO)
    .lte(APPT_SOURCE.timeCol, endISO)
    .not(APPT_SOURCE.timeCol, "is", null);

  if (options.user_id) {
    q = q.eq("user_id", options.user_id);
  } else if (options.team_id) {
    const userIds = await fetchTeamUserIds(options.team_id);
    if (userIds.length === 0) return 0;
    q = q.in("user_id", userIds);
  }

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

  // SOLD events for dashboard: Supabase, scoped (by marked-sold time)
  const [soldToday, soldWeek, soldMonth, soldAll] = await Promise.all([
    fetchSoldEventsSupabaseMarked(todayStart.toISOString(), todayEnd.toISOString(), options),
    fetchSoldEventsSupabaseMarked(weekStart.toISOString(),  weekEnd.toISOString(),  options),
    fetchSoldEventsSupabaseMarked(monthStart.toISOString(), monthEnd.toISOString(), options),
    fetchSoldEventsSupabaseMarked("1970-01-01T00:00:00.000Z", "9999-12-31T23:59:59.999Z", options),
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

  // Debug
  if (typeof window !== "undefined") {
    window.__statsDebug = { snapshot: _cache };
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
