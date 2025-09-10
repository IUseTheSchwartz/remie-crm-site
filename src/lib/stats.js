// File: src/lib/stats.js
// Dashboard + Reports helpers
// - SOLD & Premium (Reports): policy start date (c.sold.startDate)
// - SOLD & Premium (Dashboard): when it was marked sold (closed/marked date)
// - Leads: Supabase (leads.created_at) — to NOW
// - Appointments: Supabase (leads.next_follow_up_at) — to period end

import { supabase } from "../lib/supabaseClient.js";
import { loadClients } from "./storage.js";

/* ---------------- Number parsing ---------------- */
function parseNumber(x) {
  if (x == null) return 0;
  if (typeof x === "number") return x;
  const n = String(x).replace(/[$,\s]/g, "");
  const v = parseFloat(n);
  return Number.isFinite(v) ? v : 0;
}

/* ---------------- Robust date parsing ---------------- */
function toDateSafe(d) {
  if (!d) return null;
  if (d instanceof Date) return Number.isFinite(+d) ? d : null;
  const s = String(d).trim();

  // ISO / YYYY-MM-DD...
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const t = new Date(s);
    return Number.isFinite(+t) ? t : null;
  }
  // MM/DD/YYYY
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) {
    const [m, dd, y] = s.split("/").map(Number);
    const t = new Date(y, m - 1, dd, 12, 0, 0, 0); // noon local
    return Number.isFinite(+t) ? t : null;
  }
  const t = new Date(s);
  return Number.isFinite(+t) ? t : null;
}

/** Normalize to local noon to avoid UTC/off-by-one issues. */
function toLocalNoon(dateLike) {
  const d = toDateSafe(dateLike);
  if (!d) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0, 0);
}

/* ---------------- Time helpers ---------------- */
export function startOfDay(d) { const x = new Date(d); x.setHours(0,0,0,0); return x; }
export function endOfDay(d)   { const x = new Date(d); x.setHours(23,59,59,999); return x; }

export function startOfWeek(d) { const x = startOfDay(d); const diff=(x.getDay()+6)%7; x.setDate(x.getDate()-diff); return x; }
export function endOfWeek(d)   { const s = startOfWeek(d); const e = new Date(s); e.setDate(e.getDate()+6); e.setHours(23,59,59,999); return e; }

export function startOfMonth(d){ const x = startOfDay(d); x.setDate(1); return x; }
export function endOfMonth(d)  { const s = startOfMonth(d); const e = new Date(s); e.setMonth(e.getMonth()+1); e.setDate(0); e.setHours(23,59,59,999); return e; }

export function fmtDate(d)  { return new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric" }); }
export function fmtMonth(d) { return new Date(d).toLocaleDateString(undefined, { month: "short", year: "numeric" }); }
export function getWeekKey(d){ const b = startOfWeek(toLocalNoon(d) || new Date()); return b.toISOString().slice(0,10); }

/* ======================================================
   SOLD sources from local storage
   - Reports timeline: uses policy startDate
   - Dashboard timeline: uses "marked sold" date if available
====================================================== */

/** SOLD events for Reports (policy effective date) */
export function getSoldEventsFromStorage() {
  const clients = loadClients() || [];
  const sold = clients.filter((c) => c.status === "sold" && c.sold);
  return sold.map((c) => ({
    type: "policy_closed",
    date: c.sold.startDate || new Date().toISOString(), // effective date (may be future)
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

/** SOLD events for Dashboard (when you marked it sold) */
function getSoldEventsForDashboard() {
  const clients = loadClients() || [];
  const sold = clients.filter((c) => c.status === "sold" && c.sold);

  return sold.map((c) => {
    // Prefer any "closed/marked" timestamps you might have stored:
    const marked =
      c.sold.closedAt ||
      c.sold.soldAt ||
      c.sold.markedAt ||
      c.sold.dateMarked ||
      c.updated_at ||
      c.updatedAt ||
      c.created_at ||
      c.createdAt ||
      new Date().toISOString();

    return {
      type: "policy_closed",
      date: marked,                                   // ← used for Dashboard windows
      premium: parseNumber(c.sold.premium),
      name: c.sold.name || c.name || "",
      email: c.sold.email || c.email || "",
      phone: c.sold.phone || c.phone || "",
      carrier: c.sold.carrier || "",
      monthlyPayment: parseNumber(c.sold.monthlyPayment),
      faceAmount: parseNumber(c.sold.faceAmount),
      id: c.id,
    };
  });
}

/* ---------------- Totals + filters ---------------- */
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

/* ---------------- Reports grouping (sync) ---------------- */
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

/* ---------------- Supabase counts for Dashboard ---------------- */
// Leads (so-far → end = now)
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

// Appointments (to end-of-period) — leads.next_follow_up_at
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
  if (error) { console.error("[stats] appt count error:", error); return 0; }
  return count || 0;
}

/* ---------------- Dashboard cache + refresh ---------------- */
const ZERO = { leads: 0, appointments: 0, clients: 0, closed: 0, premium: 0 };

let _cache = {
  today: { ...ZERO },
  thisWeek: { ...ZERO },
  thisMonth: { ...ZERO },
  allTime: { ...ZERO },
  _updatedAt: null,
};
export function dashboardSnapshot(){ return _cache; }

/** Build SOLD timeline specifically for Dashboard (uses "marked sold" date). */
function buildSoldTimelineForDashboard() {
  return getSoldEventsForDashboard();
}

export async function refreshDashboardSnapshot(options = {}, now = new Date()) {
  // windows
  const nowISO = now.toISOString();
  const todayStart = startOfDay(now), todayEnd = endOfDay(now);
  const weekStart  = startOfWeek(now), weekEnd  = endOfWeek(now);
  const monthStart = startOfMonth(now), monthEnd = endOfMonth(now);

  // SOLD timelines
  const soldTimelineReports   = getSoldEventsFromStorage();       // for all-time parity
  let   soldTimelineDashboard = buildSoldTimelineForDashboard();  // for day/week/month

  // Optional behavior: if someone had a future policy date but marked it sold now,
  // and no explicit "marked" field exists, the function above already falls back to updated/created/now.

  // Compute SOLD totals for each dashboard bucket
  const todaySold  = getTotals(filterRange(soldTimelineDashboard, todayStart, todayEnd));
  const weekSold   = getTotals(filterRange(soldTimelineDashboard, weekStart, weekEnd));
  const monthSold  = getTotals(filterRange(soldTimelineDashboard, monthStart, monthEnd));
  const allSold    = getTotals(soldTimelineReports); // all-time totals don't depend on date buckets

  // Supabase counts (leads so-far, appts to end-of-period)
  const [
    todayLeads, weekLeads, monthLeads, allLeads,
    todayAppts, weekAppts, monthAppts, allAppts,
  ] = await Promise.all([
    countLeadsBetween(todayStart.toISOString(), nowISO, options),
    countLeadsBetween(weekStart.toISOString(),  nowISO, options),
    countLeadsBetween(monthStart.toISOString(), nowISO, options),
    countLeadsBetween("1970-01-01T00:00:00.000Z", nowISO, options),

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

  if (typeof window !== "undefined") {
    window.__statsDebug = {
      soldDashboardCount: soldTimelineDashboard.length,
      soldReportsCount:   soldTimelineReports.length,
      sampleDashboardSold: soldTimelineDashboard.slice(0, 3),
      sampleReportsSold:   soldTimelineReports.slice(0, 3),
      snapshot: _cache,
    };
  }

  return _cache;
}

/* ---------------- Reports helper ---------------- */
export function monthFromWeekKey(weekKey) {
  const d = new Date(weekKey);
  return d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
}
