// File: src/pages/CalendarPage.jsx
import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabaseClient.js";
import { useAuth } from "../auth.jsx";

/* ---------------- shared helpers ---------------- */

function fmt(dt) {
  try {
    const d = new Date(dt);
    return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    })}`;
  } catch {
    return "—";
  }
}

function classNames(...xs) {
  return xs.filter(Boolean).join(" ");
}

/* ============================================================
   LEFT: Upcoming meetings (Calendly)
   - This tries a Netlify function you likely have (calendly-events).
   - If it’s not set up yet, it will gracefully show “No upcoming meetings.”
   ============================================================ */

function UpcomingMeetings() {
  const { user } = useAuth();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      setErr("");

      try {
        // If you have a function that returns upcoming events for the current user:
        // Expected shape: [{ id, start_time, end_time, title, invitee_email, location }]
        const res = await fetch("/.netlify/functions/calendly-events", {
          method: "GET",
          headers: { "Content-Type": "application/json" },
        });

        if (!res.ok) throw new Error(await res.text());

        const data = await res.json();
        if (!active) return;
        setItems(Array.isArray(data) ? data.slice(0, 10) : []);
      } catch (e) {
        // If no function exists, or it errors, just show the empty state
        setItems([]);
        setErr(e?.message || "Failed to load meetings.");
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [user?.id]); // re-run if user changes

  return (
    <section className="mx-2 mt-2 rounded-2xl border border-white/10 bg-white/[0.03]">
      <div className="border-b border-white/10 px-3 py-2 text-sm font-medium">
        Upcoming meetings (Calendly)
      </div>
      <div className="p-3 text-sm">
        {loading ? (
          <div className="text-white/60">Loading...</div>
        ) : err ? (
          <div className="text-white/60">No upcoming meetings.</div>
        ) : items.length === 0 ? (
          <div className="text-white/60">No upcoming meetings.</div>
        ) : (
          <ul className="space-y-2">
            {items.map((ev) => (
              <li
                key={ev.id || `${ev.start_time}-${ev.title}`}
                className="rounded-lg border border-white/10 bg-black/30 px-3 py-2"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate font-medium">
                      {ev.title || "Meeting"}
                    </div>
                    <div className="truncate text-xs text-white/60">
                      {ev.invitee_email || ev.location || ""}
                    </div>
                  </div>
                  <div className="shrink-0 text-white/70">
                    {ev.start_time ? fmt(ev.start_time) : "—"}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/* ============================================================
   RIGHT: Upcoming follow-ups (Pipeline)
   - IMPORTANT FIX: no reference to `first_name` (or any missing column).
   - Only selects columns that exist: id, next_follow_up_at, phone, email.
   ============================================================ */

function leadLabel(l) {
  return l.phone || l.email || "Lead";
}

function UpcomingFollowUps() {
  const { user } = useAuth();
  const [items, setItems] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user?.id) return;
    let active = true;

    (async () => {
      setLoading(true);
      setError("");

      const { data, error } = await supabase
        .from("leads")
        // ✅ FIX: only existing columns
        .select("id,next_follow_up_at,phone,email")
        .eq("user_id", user.id)
        .not("next_follow_up_at", "is", null)
        .gte("next_follow_up_at", new Date().toISOString())
        .order("next_follow_up_at", { ascending: true })
        .limit(25);

      if (!active) return;
      if (error) setError(error.message || "Failed to load follow-ups.");
      else setItems(data || []);

      setLoading(false);
    })();

    return () => {
      active = false;
    };
  }, [user?.id]);

  return (
    <section className="mx-2 mt-2 rounded-2xl border border-white/10 bg-white/[0.03]">
      <div className="border-b border-white/10 px-3 py-2 text-sm font-medium">
        Upcoming follow-ups (Pipeline)
      </div>
      <div className="p-3 text-sm">
        {loading ? (
          <div className="text-white/60">Loading…</div>
        ) : error ? (
          <div className="text-rose-400">Could not load follow-ups. {error}</div>
        ) : items.length === 0 ? (
          <div className="text-white/60">No upcoming follow-ups.</div>
        ) : (
          <ul className="space-y-2">
            {items.map((l) => (
              <li
                key={l.id}
                className="flex items-center justify-between rounded-lg border border-white/10 bg-black/30 px-3 py-2"
              >
                <div className="truncate">{leadLabel(l)}</div>
                <div className="ml-3 shrink-0 text-white/70">
                  {fmt(l.next_follow_up_at)}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/* ============================================================
   PAGE
   ============================================================ */

export default function CalendarPage() {
  return (
    <div className="p-2">
      <h2 className="px-2 pt-1 text-lg font-semibold">Schedule</h2>

      <div className="mt-2 grid grid-cols-1 gap-4 md:grid-cols-2">
        <UpcomingMeetings />
        <UpcomingFollowUps />
      </div>
    </div>
  );
}
