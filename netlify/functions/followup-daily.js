// File: netlify/functions/followup-daily.js
// Lead Rescue (calendar-day based): Day 2 = next day at user-configured hour, then daily.
// - Uses Day 2+ bodies from lead_rescue_templates
// - loop_enabled: reuse last non-empty body after the last configured day
// - Stops on inbound reply since contact.created_at
// - Uses next_run_at with a forgiving window (so small timing drift doesn't skip)
// Test switches:
//   ?force=1            -> ignore next_run_at window and hour gate; consider all active trackers
//   ?user_id=<uuid>     -> process only that user

const { createClient } = require("@supabase/supabase-js");

const DEFAULT_TZ = "America/Chicago";
const DEFAULT_HOUR = 9;

// Forgiving window around next_run_at
const WINDOW_BEFORE_MIN = 10; // run up to 10m early
const WINDOW_AFTER_MIN  = 30; // or up to 30m late

function admin() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing Supabase admin env");
  return createClient(url, key, { auth: { persistSession: false } });
}

// ---- time helpers (TZ-aware via Intl) ----
function localParts(date, tz) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(date);
  const m = Object.fromEntries(fmt.map(p => [p.type, p.value]));
  return { y:+m.year, m:+m.month, d:+m.day, hh:+m.hour, mm:+m.minute, ss:+m.second };
}
function localDateKey(date, tz) {
  const { y, m, d } = localParts(date, tz);
  return `${y}-${String(m).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
}
function daysSince(start, now, tz) {
  const startKey = localDateKey(new Date(start), tz);
  const nowKey   = localDateKey(now, tz);
  const s = new Date(`${startKey}T00:00:00`);
  const n = new Date(`${nowKey}T00:00:00`);
  return Math.round((n - s) / 86400000);
}
function sameLocalDay(a, b, tz) {
  return localDateKey(a, tz) === localDateKey(b, tz);
}

// ---- send raw body through messages-send ----
async function sendBody(contactId, body, meta = {}) {
  const base = process.env.SITE_URL || process.env.URL;
  if (!base) throw new Error("Missing SITE_URL/URL");
  const res = await fetch(base + "/.netlify/functions/messages-send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // IMPORTANT: send actual body so lead_rescue_templates is used
    body: JSON.stringify({
      contact_id: contactId,
      body,
      trace_meta: { reason: "lead_rescue_due", ...meta },
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(()=> "");
    throw new Error(`messages-send failed: ${res.status} ${t}`);
  }
}

exports.handler = async (event) => {
  const db = admin();
  const now = new Date();
  const qs = (event && event.queryStringParameters) || {};
  const force = String(qs.force || "") === "1";
  const onlyUser = qs.user_id || null;

  // 1) Enabled users + settings
  let sQuery = db
    .from("lead_rescue_settings")
    .select("user_id, enabled, send_tz, send_hour_local, loop_enabled")
    .eq("enabled", true);
  if (onlyUser) sQuery = sQuery.eq("user_id", onlyUser);

  const { data: settings, error: sErr } = await sQuery;
  if (sErr) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: sErr.message }) };
  }
  if (!settings?.length) {
    return { statusCode: 200, body: JSON.stringify({ ok: true, users: 0, totalSent: 0, results: [] }) };
  }

  let totalSent = 0;
  const results = [];

  for (const s of settings) {
    const tz   = s.send_tz || DEFAULT_TZ;
    const hour = Number.isFinite(s.send_hour_local) ? s.send_hour_local : DEFAULT_HOUR;
    const loopEnabled = !!s.loop_enabled;

    // 2) Trackers: active, not responded, due (by next_run_at window) unless force
    const earlyISO = new Date(now.getTime() - WINDOW_BEFORE_MIN*60*1000).toISOString();
    const lateISO  = new Date(now.getTime() + WINDOW_AFTER_MIN*60*1000).toISOString();

    let tQuery = db
      .from("lead_rescue_trackers")
      .select("contact_id, current_day, last_attempt_at, responded, paused, started_at, updated_at, next_run_at")
      .eq("user_id", s.user_id)
      .eq("seq_key", "lead_rescue")
      .eq("responded", false);

    if (!force) {
      tQuery = tQuery.gte("next_run_at", earlyISO).lte("next_run_at", lateISO);
    }

    const { data: trs, error: tErr } = await tQuery;
    if (tErr) {
      results.push({ user: s.user_id, error: "trackers_load_failed", detail: tErr.message });
      continue;
    }
    const active = (trs || []).filter(r => !r.paused);
    if (!active.length) {
      results.push({ user: s.user_id, sent: 0, considered: 0, skipped: force ? "no_active" : "no_due_in_window" });
      continue;
    }

    // 3) Contacts for these trackers
    const ids = active.map(a => a.contact_id);
    const { data: contacts, error: cErr } = await db
      .from("message_contacts")
      .select("id, user_id, tags, created_at")
      .in("id", ids);

    if (cErr) {
      results.push({ user: s.user_id, error: "contacts_load_failed", detail: cErr.message });
      continue;
    }
    const contactById = new Map((contacts || []).map(c => [c.id, c]));

    // 4) Messages history (to stop on inbound since contact.created_at)
    const { data: msgs, error: mErr } = await db
      .from("messages")
      .select("contact_id, created_at, direction")
      .in("contact_id", ids);

    if (mErr) {
      results.push({ user: s.user_id, error: "messages_load_failed", detail: mErr.message });
      continue;
    }
    const msgsByContact = new Map();
    for (const m of msgs || []) {
      if (!msgsByContact.has(m.contact_id)) msgsByContact.set(m.contact_id, []);
      msgsByContact.get(m.contact_id).push(m);
    }

    // 5) Templates Day 2+ for this user (map day_number -> body)
    const { data: tpls, error: tplErr } = await db
      .from("lead_rescue_templates")
      .select("day_number, body")
      .eq("user_id", s.user_id)
      .order("day_number", { ascending: true });

    if (tplErr) {
      results.push({ user: s.user_id, error: "templates_load_failed", detail: tplErr.message });
      continue;
    }

    const templateMap = new Map();
    for (const t of tpls || []) {
      if ((t.day_number || 0) >= 2) {
        const b = (t.body || "").trim();
        if (b) templateMap.set(t.day_number, b);
      }
    }
    const nonEmptyDays = [...templateMap.keys()].sort((a,b)=>a-b);
    const lastNonEmptyDay = nonEmptyDays.length ? nonEmptyDays[nonEmptyDays.length - 1] : null;
    const lastNonEmptyBody = lastNonEmptyDay ? templateMap.get(lastNonEmptyDay) : null;

    let sentForUser = 0;

    // 6) Who should get a message now?
    for (const tr of active) {
      const c = contactById.get(tr.contact_id);
      if (!c) continue;

      // Must still be lead/military
      const tags = Array.isArray(c.tags) ? c.tags.map(t=>String(t).toLowerCase()) : [];
      if (!tags.includes("lead") && !tags.includes("military")) continue;

      // Stop if inbound since lead created
      const history = msgsByContact.get(tr.contact_id) || [];
      const inboundAfterLead = history.some(
        m => m.direction === "inbound" && new Date(m.created_at) >= new Date(c.created_at)
      );
      if (inboundAfterLead) continue;

      // Safety: once per local calendar day (prevents duplicate within window)
      if (tr.last_attempt_at && sameLocalDay(new Date(tr.last_attempt_at), now, tz)) continue;

      // Determine the day number (Day 1 is creation day; rescue begins Day 2)
      const startAnchor = tr.started_at || c.created_at; // prefer tracker.start
      const dayNumber = Math.max(2, 1 + daysSince(startAnchor, now, tz));

      // Only send if advancing beyond what we've already sent
      const current = tr.current_day || 1;
      if (dayNumber <= current) continue;

      // Pick body for this day
      let body = null;
      if (templateMap.has(dayNumber)) {
        body = templateMap.get(dayNumber);
      } else if (lastNonEmptyBody && loopEnabled && dayNumber > lastNonEmptyDay) {
        body = lastNonEmptyBody; // loop reuse
      } else {
        // No template and no loop → skip without advancing
        continue;
      }

      // Send & advance to the *actual* computed day
      try {
        await sendBody(tr.contact_id, body, { day_number: dayNumber });

        // Advance to this day and compute next_run_at on the DB side
        const { error: advErr } = await db.rpc("lead_rescue_advance_after_send", {
          p_user_id: s.user_id,
          p_contact_id: tr.contact_id,
          p_new_day: dayNumber,
        });
        if (advErr) throw advErr;

        sentForUser += 1;
      } catch (e) {
        // Record reason; do not advance day
        await db
          .from("lead_rescue_trackers")
          .update({ stop_reason: String(e), updated_at: new Date().toISOString() })
          .eq("contact_id", tr.contact_id)
          .eq("user_id", s.user_id)
          .eq("seq_key", "lead_rescue");
      }
    }

    totalSent += sentForUser;
    results.push({ user: s.user_id, sent: sentForUser, considered: active.length });
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ ok: true, users: settings.length, totalSent, results }),
    headers: { "Content-Type": "application/json" },
  };
};
