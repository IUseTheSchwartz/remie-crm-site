// File: src/pages/CalendarPage.jsx
import { useEffect, useState } from "react";
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
   LEFT (top): Upcoming CRM Appointments (booked via AI/SMS)
   ============================================================ */

function UpcomingCrmAppointments() {
  const { user } = useAuth();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!user?.id) return;
    let active = true;

    (async () => {
      setLoading(true);
      setErr("");

      const { data, error } = await supabase
        .from("crm_appointments")
        .select("id, title, scheduled_at, time_label, source, contact_id")
        .eq("user_id", user.id)
        .gte("scheduled_at", new Date().toISOString())
        .order("scheduled_at", { ascending: true })
        .limit(25);

      if (!active) return;
      if (error) {
        setErr(error.message || "Failed to load appointments.");
        setItems([]);
      } else {
        setItems(data || []);
      }
      setLoading(false);
    })();

    return () => {
      active = false;
    };
  }, [user?.id]);

  return (
    <section className="mx-2 mt-2 rounded-2xl border border-white/10 bg-white/[0.03]">
      <div className="border-b border-white/10 px-3 py-2 text-sm font-medium">
        Upcoming CRM Appointments
      </div>
      <div className="p-3 text-sm">
        {loading ? (
          <div className="text-white/60">Loading…</div>
        ) : err ? (
          <div className="text-rose-400">Error: {err}</div>
        ) : items.length === 0 ? (
          <div className="text-white/60">No upcoming CRM appointments.</div>
        ) : (
          <ul className="space-y-2">
            {items.map((ev) => (
              <li
                key={ev.id}
                className="rounded-lg border border-white/10 bg-black/30 px-3 py-2"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate font-medium">
                      {ev.title || "Discovery Call"}
                    </div>
                    <div className="truncate text-xs text-white/60">
                      {ev.time_label ? `Chosen: ${ev.time_label}` : ev.source ? ev.source : ""}
                    </div>
                  </div>
                  <div className="shrink-0 text-white/70">
                    {ev.scheduled_at ? fmt(ev.scheduled_at) : "—"}
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
   LEFT (bottom): Upcoming meetings (Calendly)  — (your original)
   ============================================================ */

function UpcomingMeetings() {
  const { user } = useAuth();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!user?.id) return;
    let active = true;

    (async () => {
      setLoading(true);
      setErr("");
      try {
        // Call your Netlify function WITH uid so it can find your token
        const res = await fetch(`/.netlify/functions/calendly-events?uid=${user.id}`);
        const data = await res.json().catch(() => ({}));

        if (!res.ok || data?.error) {
          throw new Error(data?.error || `HTTP ${res.status}`);
        }

        // Your function returns Calendly's raw payload: { collection: [...] }
        const collection = Array.isArray(data?.collection) ? data.collection : [];

        // Map Calendly event shape -> your UI fields
        const mapped = collection.map((ev) => ({
          id: ev.uri || ev.id,
          title: ev.name || "Meeting",
          start_time: ev.start_time,
          // prefer join_url (Zoom/Meet), else plain location string
          location:
            (ev.location && (ev.location.join_url || ev.location.location)) || "",
          // scheduled_events doesn't include invitee emails; leave blank
          invitee_email: "",
        }));

        if (active) setItems(mapped.slice(0, 10));
      } catch (e) {
        if (active) {
          setItems([]);
          setErr(e?.message || "Failed to load meetings.");
        }
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [user?.id]);

  return (
    <section className="mx-2 mt-2 rounded-2xl border border-white/10 bg-white/[0.03]">
      <div className="border-b border-white/10 px-3 py-2 text-sm font-medium">
        Upcoming meetings (Calendly)
      </div>
      <div className="p-3 text-sm">
        {loading ? (
          <div className="text-white/60">Loading...</div>
        ) : err ? (
          <div className="text-rose-400">Calendly error: {err}</div>
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
   RIGHT: Upcoming follow-ups (Pipeline) — with names
   ============================================================ */

function leadLabel(l) {
  const name = (l.name || "").trim();
  if (name) return name;
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
        .select("id,next_follow_up_at,phone,email,name")
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
        <div>
          <UpcomingCrmAppointments />
          <UpcomingMeetings />
        </div>
        <UpcomingFollowUps />
      </div>
    </div>
  );
}
