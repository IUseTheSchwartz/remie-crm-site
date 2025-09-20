// netlify/functions/lead-rescue-cron.js
// Runs hourly and only sends when it is the user's configured local hour (default 9am America/Chicago)

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

// Your existing sender function base (matches your code pattern)
const FN_BASE = process.env.PUBLIC_APP_URL
  ? `${process.env.PUBLIC_APP_URL}/.netlify/functions`
  : "/.netlify/functions";

// Helpers
function isSameLocalDay(a, b, tz) {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    return fmt.format(a) === fmt.format(b);
  } catch {
    return false;
  }
}

function getLocalHour(date, tz) {
  try {
    return Number(
      new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hour12: false,
        hour: "numeric",
      }).format(date)
    );
  } catch {
    // Fallback to UTC hour
    return date.getUTCHours();
  }
}

async function sendRawText({ requesterId, to, body, leadId }) {
  // We call your existing messages-send function which bills 1¢ and writes to messages table.
  const res = await fetch(`${FN_BASE}/messages-send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requesterId,
      to,
      body,
      lead_id: leadId || undefined,
      templateKey: "lead_rescue", // just for traceability; your fn can ignore this
    }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok || out.error) {
    throw new Error(out.error || `messages-send failed: ${res.status}`);
  }
  return out;
}

export const config = {
  // Run hourly. We'll gate by local hour per-user so it only sends at their configured time.
  schedule: "@hourly",
};

export async function handler() {
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

  // 1) Load all enabled users + settings
  const { data: settings, error: sErr } = await supabase
    .from("lead_rescue_settings")
    .select("*")
    .eq("enabled", true);

  if (sErr) {
    console.error("settings error", sErr);
    return { statusCode: 500, body: "settings error" };
  }
  if (!settings || settings.length === 0) {
    return { statusCode: 200, body: "no enabled users" };
  }

  const now = new Date();

  for (const s of settings) {
    const userId = s.user_id;
    const tz = s.send_tz || "America/Chicago";
    const sendHour = Number.isFinite(+s.send_hour_local) ? +s.send_hour_local : 9;
    const maxDays = Math.max(2, +s.max_days || 5);
    const repeatAfter = s.repeat_after_days == null ? null : +s.repeat_after_days;

    // Hourly guard: only act if it's the configured local hour for this user
    const hourLocal = getLocalHour(now, tz);
    if (hourLocal !== sendHour) continue;

    // Grab trackers due today (not paused/responded), still in window
    const { data: trackers, error: tErr } = await supabase
      .from("lead_rescue_trackers")
      .select("contact_id, current_day, last_attempt_at, responded, paused, stop_reason")
      .eq("user_id", userId)
      .eq("responded", false)
      .eq("paused", false);

    if (tErr) {
      console.error("trackers error", userId, tErr);
      continue;
    }
    if (!trackers?.length) continue;

    // Bring in contacts (to ensure they still exist and have the 'lead' or 'military' tag)
    const contactIds = trackers.map(t => t.contact_id);
    const { data: contacts, error: cErr } = await supabase
      .from("message_contacts")
      .select("id, phone, full_name, tags, lead_id")
      .in("id", contactIds)
      .eq("user_id", userId);

    if (cErr) {
      console.error("contacts error", userId, cErr);
      continue;
    }

    // Build a quick lookup
    const byId = new Map(contacts.map(c => [c.id, c]));

    for (const trk of trackers) {
      const contact = byId.get(trk.contact_id);
      if (!contact) {
        // Contact was deleted -> stop this tracker
        await supabase.from("lead_rescue_trackers")
          .update({ paused: true, stop_reason: "no_contact" })
          .eq("user_id", userId).eq("contact_id", trk.contact_id);
        continue;
      }

      // Only if they’re still tagged lead/military
      const tagset = new Set((contact.tags || []).map(t => String(t || "").toLowerCase()));
      const eligible = tagset.has("lead") || tagset.has("military");
      if (!eligible) continue;

      // Only once per local day
      if (trk.last_attempt_at) {
        const last = new Date(trk.last_attempt_at);
        if (isSameLocalDay(last, now, tz)) continue; // already attempted today
      }

      // Day gating: Day 1 is the “new lead” message you already send. We start at Day 2+
      const day = Math.max(2, trk.current_day + 1); // advance to the *next* day
      if (day > maxDays && repeatAfter == null) {
        // completed, stop
        await supabase.from("lead_rescue_trackers")
          .update({
            current_day: trk.current_day, // keep
            paused: true,
            stop_reason: "completed",
            last_attempt_at: now.toISOString(),
          })
          .eq("user_id", userId).eq("contact_id", trk.contact_id);
        continue;
      }

      let effectiveDay = day;
      if (day > maxDays && repeatAfter != null) {
        // loop back to Day 2
        effectiveDay = 2;
      }

      // Fetch template for that day
      const { data: tpl, error: dErr } = await supabase
        .from("lead_rescue_templates")
        .select("body")
        .eq("user_id", userId)
        .eq("day_number", effectiveDay)
        .maybeSingle();

      if (dErr) {
        console.error("template error", userId, trk.contact_id, effectiveDay, dErr);
        continue;
      }

      const rawBody = (tpl?.body || "").trim();

      // If empty template, we just advance the day and mark last_attempt_at (so you aren’t stuck forever)
      const newDay = (effectiveDay >= maxDays && repeatAfter == null) ? effectiveDay : effectiveDay; // advance to what we just processed
      const nextDay = (repeatAfter == null)
        ? Math.min(maxDays, newDay) // cap at max
        : (newDay >= maxDays ? 1 : newDay); // we’ll re-advance next cycle

      // Send if there is a body
      if (rawBody) {
        try {
          await sendRawText({
            requesterId: userId,
            to: contact.phone,
            body: rawBody,
            leadId: contact.lead_id || undefined,
          });
        } catch (e) {
          console.error("send error", userId, trk.contact_id, e?.message || e);
          // still advance last_attempt_at so we don’t retry repeatedly the same hour
          await supabase.from("lead_rescue_trackers")
            .update({
              current_day: effectiveDay,
              last_attempt_at: now.toISOString(),
            })
            .eq("user_id", userId).eq("contact_id", trk.contact_id);
          continue;
        }
      }

      // Advance tracker
      const updates = {
        current_day: effectiveDay,
        last_attempt_at: now.toISOString(),
      };

      // If we just sent/processed the final day and no repeat, stop it
      if (effectiveDay >= maxDays && repeatAfter == null) {
        updates.paused = true;
        updates.stop_reason = "completed";
      }

      await supabase
        .from("lead_rescue_trackers")
        .update(updates)
        .eq("user_id", userId)
        .eq("contact_id", trk.contact_id);
    }
  }

  return { statusCode: 200, body: "ok" };
}
