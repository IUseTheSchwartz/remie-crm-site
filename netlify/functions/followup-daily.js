// File: netlify/functions/followup-daily.js
// Calendar-day based follow-ups: next day at send hour (local), then daily.
// If loop_enabled=true and there's no template for a day, reuse the last non-empty template daily.
// Stops on inbound reply (since contact.created_at).

const { createClient } = require("@supabase/supabase-js");

const DEFAULT_TZ = "America/Chicago";
const TEMPLATE_KEY_FALLBACK = "follow_up_2d"; // reuse your existing template key/category

function admin() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing Supabase admin env");
  return createClient(url, key);
}

// --- time helpers ---
function localParts(date, tz) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const m = Object.fromEntries(fmt.map(p => [p.type, p.value]));
  return { y:+m.year, m:+m.month, d:+m.day, hh:+m.hour, mm:+m.minute, ss:+m.second };
}
function localDateKey(date, tz) {
  const { y, m, d } = localParts(date, tz);
  return `${y}-${String(m).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
}
function isRightHour(date, tz, targetHour) {
  const { hh } = localParts(date, tz);
  return hh === Number(targetHour);
}
function daysSince(startDate, now, tz) {
  // Difference in calendar days in the target TZ
  const sKey = localDateKey(new Date(startDate), tz);
  const nKey = localDateKey(now, tz);
  const s = new Date(sKey + "T00:00:00");
  const n = new Date(nKey + "T00:00:00");
  return Math.round((n - s) / 86400000);
}
function sameLocalDay(a, b, tz) {
  return localDateKey(a, tz) === localDateKey(b, tz);
}

// --- sending ---
async function sendTemplate(contactId, templateKey, meta = {}) {
  const res = await fetch(process.env.URL + "/.netlify/functions/messages-send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contact_id: contactId,
      template_key: templateKey,
      trace_meta: { reason: "lead_rescue_due", ...meta },
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(()=> "");
    throw new Error(`messages-send failed: ${res.status} ${t}`);
  }
}

exports.handler = async () => {
  const db = admin();
  const now = new Date();

  // 1) Get enabled users + their settings
  const { data: settings, error: sErr } = await db
    .from("lead_rescue_settings")
    .select("user_id, enabled, send_tz, send_hour_local, loop_enabled")
    .eq("enabled", true);

  if (sErr) throw sErr;
  if (!settings || !settings.length) {
    return { statusCode: 200, body: JSON.stringify({ ok: true, users: 0, sent: 0 }) };
  }

  let totalSent = 0;
  const results = [];

  for (const s of settings) {
    const tz = s.send_tz || DEFAULT_TZ;
    const hour = Number.isFinite(s.send_hour_local) ? s.send_hour_local : 9;
    const loopEnabled = !!s.loop_enabled;

    // Gate by each user's hour in their timezone
    if (!isRightHour(now, tz, hour)) {
      results.push({ user: s.user_id, skipped: "outside_user_hour" });
      continue;
    }

    // 2) Load trackers for this user that are active and not responded
    const { data: trs, error: tErr } = await db
      .from("lead_rescue_trackers")
      .select("contact_id, current_day, last_attempt_at, responded, paused, started_at")
      .eq("user_id", s.user_id)
      .eq("responded", false);

    if (tErr) throw tErr;

    const active = (trs || []).filter(r => !r.paused);
    if (active.length === 0) {
      results.push({ user: s.user_id, sent: 0, considered: 0 });
      continue;
    }

    // 3) Load contacts for those trackers
    const ids = active.map(a => a.contact_id);
    const { data: contacts, error: cErr } = await db
      .from("message_contacts")
      .select("id, user_id, tags, created_at")
      .in("id", ids);

    if (cErr) throw cErr;

    const contactById = new Map((contacts || []).map(c => [c.id, c]));

    // 4) Load messages for those contacts to compute inbound-since-lead & last attempt day guard
    const { data: msgs, error: mErr } = await db
      .from("messages")
      .select("contact_id, created_at, direction")
      .in("contact_id", ids);

    if (mErr) throw mErr;

    const msgsByContact = new Map();
    for (const m of msgs || []) {
      if (!msgsByContact.has(m.contact_id)) msgsByContact.set(m.contact_id, []);
      msgsByContact.get(m.contact_id).push(m);
    }

    // 5) Load templates Day 2+ for this user (map day_number => body)
    const { data: tpls, error: tplErr } = await db
      .from("lead_rescue_templates")
      .select("day_number, body")
      .eq("user_id", s.user_id)
      .order("day_number", { ascending: true });

    if (tplErr) throw tplErr;

    const templateMap = new Map();
    for (const t of tpls || []) {
      if (t.day_number >= 2 && (t.body || "").trim().length > 0) {
        templateMap.set(t.day_number, t.body.trim());
      }
    }
    // Track last non-empty template day
    const nonEmptyDays = [...templateMap.keys()].sort((a,b)=>a-b);
    const lastNonEmptyDay = nonEmptyDays.length ? nonEmptyDays[nonEmptyDays.length - 1] : null;

    let sentForUser = 0;

    // 6) Evaluate who should get a message today
    for (const tr of active) {
      const c = contactById.get(tr.contact_id);
      if (!c) continue;

      // Must be lead or military
      const tags = Array.isArray(c.tags) ? c.tags : [];
      if (!tags.includes("lead") && !tags.includes("military")) continue;

      // If inbound since contact.created_at -> stop
      const history = msgsByContact.get(tr.contact_id) || [];
      const inboundAfterLead = history.some(m => m.direction === "inbound" && new Date(m.created_at) >= new Date(c.created_at));
      if (inboundAfterLead) continue;

      // Only once per local day
      if (tr.last_attempt_at && sameLocalDay(new Date(tr.last_attempt_at), now, tz)) {
        continue;
      }

      // Which "day number" is today?
      // Day 1 is the day they entered (your initial). First follow-up goes on Day 2 (next calendar day).
      const dayNumber = 1 + daysSince(c.created_at, now, tz);

      if (dayNumber < 2) continue; // before first follow-up day in local calendar

      // Pick template:
      let templateKey = TEMPLATE_KEY_FALLBACK; // we still route through messages-send by key
      let shouldSend = false;

      if (templateMap.has(dayNumber)) {
        // Specific template exists
        shouldSend = true;
      } else if (loopEnabled && lastNonEmptyDay) {
        // After the last configured day: reuse last non-empty template daily
        if (dayNumber > lastNonEmptyDay) shouldSend = true;
      } else {
        // No template for this day and no loop -> skip
        shouldSend = false;
      }

      if (!shouldSend) continue;

      // 7) Send
      try {
        await sendTemplate(tr.contact_id, templateKey, { day_number: dayNumber });

        // 8) Update tracker: bump to next day and set last_attempt_at
        const { error: upErr } = await db
          .from("lead_rescue_trackers")
          .update({
            current_day: Math.max(tr.current_day || 1, dayNumber) + 1,
            last_attempt_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("contact_id", tr.contact_id)
          .eq("user_id", s.user_id);
        if (upErr) throw upErr;

        sentForUser += 1;
      } catch (e) {
        // Optional: record error reason on tracker
        await db
          .from("lead_rescue_trackers")
          .update({ stop_reason: String(e), updated_at: new Date().toISOString() })
          .eq("contact_id", tr.contact_id)
          .eq("user_id", s.user_id);
      }
    }

    totalSent += sentForUser;
    results.push({ user: s.user_id, sent: sentForUser, considered: active.length });
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ ok: true, users: settings.length, totalSent, results }),
  };
};
