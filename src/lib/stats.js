// File: src/lib/stats.js
// Dashboard & Reports helpers
// - Leads (Supabase): leads.created_at
// - Appointments (Supabase): leads.next_follow_up_at (end-of-period windows)
// - CLOSED & Premium: Local storage first (same as Reports), fallback to Supabase if empty
// - Reports timeline remains synchronous (local storage) to avoid white-screen.

import { supabase } from "../lib/supabaseClient.js";
import { loadClients } from "./storage.js";

/* ======================================================================
   Number parsing
====================================================================== */
function parseNumber(x) {
  if (x == null) return 0;
  if (typeof x === "number") return x;
  const n = String(x).replace(/[$,\s]/g, "");
  const v = parseFloat(n);
  return Number.isFinite(v) ? v : 0;
}

/* ======================================================================
   Time helpers
====================================================================== */
export function startOfDay(d) { const x = new Date(d); x.setHours(0,0,0,0); return x; }
export function endOfDay(d)   { const x = new Date(d); x.setHours(23,59,59,999); return x; }

export function startOfWeek(d) { const x = startOfDay(d); const diff=(x.getDay()+6)%7; x.setDate(x.getDate()-diff); return x; }
export function endOfWeek(d)   { const s = startOfWeek(d); const e = new Date(s); e.setDate(e.getDate()+6); e.setHours(23,59,59,999); return e; }

export function startOfMonth(d) { const x = startOfDay(d); x.setDate(1); return x; }
export function endOfMonth(d)   { const s = startOfMonth(d); const e = new Date(s); e.setMonth(e.getMonth()+1); e.setDate(0); e.setHours(23,59,59,999); return e; }

export function fmtDate(d)  { return new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric" }); }
export function fmtMonth(d) { return new Date(d).toLocaleDateString(undefined, { month: "short", year: "numeric" }); }
export function getWeekKey(d) { const b = startOfWeek(new Date(d)); return b.toISOString().slice(0,10); }

/* ======================================================================
   Local SOLD source (used by Reports and as primary source for Dashboard)
====================================================================== */
export function getSoldEventsFromStorage() {
  const clients = loadClients() || [];
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

/* ======================================================================
   Generic totals + filters
====================================================================== */
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

/* ======================================================================
   Reports timeline (sync, local storage)
====================================================================== */
function timeline() { return getSoldEventsFromStorage(); }

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
  for (const it of items || []) {
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
  for (const it of items || []) {
    const key = getWeekKey(it.date);
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
  for (const it of items || []) {
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

/* ======================================================================
   Supabase helpers (Leads, Appointments, SOLD fallback)
====================================================================== */
// LEADS (so-far windows)
async function countLeadsBetween(startISO, endISO, options = {}) {
  let q = supabase.from("leads")
    .select("id", { count: "exact" })
    .gte("created_at", startISO)
    .lte("created_at", endISO)
    .limit(1);
  if (options.team_id) q = q.eq("team_id", options.team_id);
  if (options.user_id) q = q.eq("user_id", options.user_id);
  if (options.extraFilters) q = options.extraFilters(q);
  const { count, error } = await q;
  if (error) { console.error("[stats] lead count error:", error); return 0; }
  return count || 0;
}

// APPOINTMENTS (end-of-period windows) → leads.next_follow_up_at
const APPT_SOURCE = { table: "leads", timeCol: "next_follow_up_at" };
async function countAppointmentsBetween(startISO, endISO, options = {}) {
  let q = supabase.from(APPT_SOURCE.table)
    .select("id", { count: "exact" })
    .gte(APPT_SOURCE.timeCol, startISO)
    .lte(APPT_SOURCE.timeCol, endISO)
    .not(APPT_SOURCE.timeCol, "is", null)
    .limit(1);
  if (options.team_id) q = q.eq("team_id", options.team_id);
  if (options.user_id) q = q.eq("user_id", options.user_id);
  const { count, error } = await q;
  if (error) { console.error("[stats] appointment count error:", error); return 0; }
  return count || 0;
}

// SOLD fallback from Supabase (if local storage is empty for the window)
async function fetchSoldRowsBetween(startISO, endISO, options = {}) {
  const cols = "id,user_id,team_id,status,stage,created_at,sold_at,sold_premium,premium,monthlyPayment";
  // Try sold_at range (if your schema has it)
  try {
    let q = supabase.from("leads")
      .select(cols)
      .or("status.eq.sold,stage.eq.sold")
      .gte("sold_at", startISO)
      .lte("sold_at", endISO);
    if (options.team_id) q = q.eq("team_id", options.team_id);
    if (options.user_id) q = q.eq("user_id", options.user_id);
    const { data, error } = await q;
    if (!error && data) return data;
  } catch (_) {}
  // Fallback: created_at window (counts sold leads created in window)
  try {
    let q2 = supabase.from("leads")
      .select(cols)
      .or("status.eq.sold,stage.eq.sold")
      .gte("created_at", startISO)
      .lte("created_at", endISO);
    if (options.team_id) q2 = q2.eq("team_id", options.team_id);
    if (options.user_id) q2 = q2.eq("user_id", options.user_id);
    const { data: d2, error: e2 } = await q2;
    if (!e2 && d2) return d2;
  } catch (_) {}
  return [];
}

function sumSoldPremium(rows = []) {
  return (rows || []).reduce((acc, r) => {
    const v = parseNumber(r.sold_premium) || parseNumber(r.premium) || parseNumber(r.monthlyPayment);
    return acc + v;
  }, 0);
}

/* ======================================================================
   Dashboard cache + refresh
====================================================================== */
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

async function soldTotalsWithFallback(fromDate, toDate, options = {}, soldTimeline = []) {
  // 1) Local storage (same as Reports)
  const localItems = filterRange(soldTimeline, fromDate, toDate);
  const localTotals = getTotals(localItems);
  if (localTotals.closed > 0 || localTotals.premium > 0) return localTotals;

  // 2) Fallback to Supabase if local had none (keeps tiles from being blank)
  const rows = await fetchSoldRowsBetween(fromDate.toISOString(), toDate.toISOString(), options);
  return {
    leads: 0,
    appointments: 0,
    clients: 0,
    closed: rows.length,
    premium: sumSoldPremium(rows),
  };
}

export async function refreshDashboardSnapshot(options = {}, now = new Date()) {
  // Lead windows: start..NOW (so far)
  const nowISO = now.toISOString();
  const todayStart = startOfDay(now), weekStart = startOfWeek(now), monthStart = startOfMonth(now);

  // Appointment windows: start..END OF PERIOD (upcoming within the period)
  const todayEnd = endOfDay(now);
  const weekEnd  = endOfWeek(now);
  const monthEnd = endOfMonth(now);
  const allEnd   = new Date("9999-12-31T23:59:59.999Z");

  // Build local SOLD timeline once (local storage)
  const soldTimeline = getSoldEventsFromStorage();

  // Parallelize everything
  const [
    // Leads (so far)
    todayLeads, weekLeads, monthLeads, allLeads,
    // Appointments (to end-of-period)
    todayAppts, weekAppts, monthAppts, allAppts,
    // SOLD (local first, Supabase fallback per bucket)
    todaySoldTotals, weekSoldTotals, monthSoldTotals, allSoldTotals,
  ] = await Promise.all([
    countLeadsBetween(todayStart.toISOString(), nowISO, options),
    countLeadsBetween(weekStart.toISOString(),  nowISO, options),
    countLeadsBetween(monthStart.toISOString(), nowISO, options),
    countLeadsBetween("1970-01-01T00:00:00.000Z", nowISO, options),

    countAppointmentsBetween(todayStart.toISOString(), todayEnd.toISOString(), options),
    countAppointmentsBetween(weekStart.toISOString(),  weekEnd.toISOString(),  options),
    countAppointmentsBetween(monthStart.toISOString(), monthEnd.toISOString(), options),
    countAppointmentsBetween("1970-01-01T00:00:00.000Z", allEnd.toISOString(), options),

    soldTotalsWithFallback(todayStart, todayEnd, options, soldTimeline),
    soldTotalsWithFallback(weekStart,  weekEnd,  options, soldTimeline),
    soldTotalsWithFallback(monthStart, monthEnd, options, soldTimeline),
    soldTotalsWithFallback(new Date("1970-01-01T00:00:00.000Z"), allEnd, options, soldTimeline),
  ]);

  // Compose cache objects
  const todayTotals = { ...todaySoldTotals, leads: todayLeads, appointments: todayAppts };
  const weekTotals  = { ...weekSoldTotals,  leads: weekLeads,  appointments: weekAppts  };
  const monthTotals = { ...monthSoldTotals, leads: monthLeads, appointments: monthAppts };
  const allTotals   = { ...allSoldTotals,   leads: allLeads,   appointments: allAppts   };

  _cache = {
    today: todayTotals,
    thisWeek: weekTotals,
    thisMonth: monthTotals,
    allTime: allTotals,
    _updatedAt: new Date().toISOString(),
  };

  return _cache;
}

/* ======================================================================
   Helper for Weekly tab label suffix in ReportsPage
====================================================================== */
export function monthFromWeekKey(weekKey) {
  const d = new Date(weekKey);
  return d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
}
