// File: src/pages/CalendarPage.jsx
import { useEffect, useState } from "react";
import { supabase } from "./lib/supabaseClient.js";

export default function CalendarPage() {
  const [userId, setUserId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [events, setEvents] = useState([]);
  const [err, setErr] = useState("");

  useEffect(() => {
    let cancel = false;

    async function run() {
      setLoading(true);
      setErr("");
      setEvents([]);

      // 1) who am I?
      const { data, error } = await supabase.auth.getUser();
      if (error) {
        if (!cancel) {
          setErr(error.message || "Not authenticated");
          setLoading(false);
        }
        return;
      }
      const uid = data?.user?.id;
      if (!uid) {
        if (!cancel) {
          setErr("Not authenticated");
          setLoading(false);
        }
        return;
      }
      setUserId(uid);

      // 2) hit our Netlify function
      try {
        const res = await fetch(
          `/.netlify/functions/calendly-events?uid=${encodeURIComponent(uid)}&count=50`
        );
        if (!res.ok) {
          const t = await res.text();
          throw new Error(t || `HTTP ${res.status}`);
        }
        const payload = await res.json();

        // Calendly returns { collection: [ ...events ], pagination: {...} }
        const list = Array.isArray(payload?.collection) ? payload.collection : [];
        if (!cancel) setEvents(list);
      } catch (e) {
        if (!cancel) setErr(e.message || "Failed to load events");
      } finally {
        if (!cancel) setLoading(false);
      }
    }

    run();
    return () => { cancel = true; };
  }, []);

  const prettyDate = (iso) => {
    if (!iso) return "—";
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  };

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Upcoming meetings</h1>

      {loading && (
        <div className="rounded-2xl border p-4">Loading…</div>
      )}

      {!loading && err && (
        <div className="rounded-2xl border p-4 text-red-500">
          Could not load events. {err}
        </div>
      )}

      {!loading && !err && events.length === 0 && (
        <div className="rounded-2xl border p-4 text-gray-400">
          No upcoming meetings.
        </div>
      )}

      {!loading && !err && events.length > 0 && (
        <div className="rounded-2xl border divide-y">
          {events.map((ev) => {
            const start = ev.start_time;
            const end = ev.end_time;
            const title = ev.name || "Meeting";
            const location = ev.location?.type === "physical"
              ? ev.location?.location
              : ev.location?.type === "zoom"
                ? "Zoom"
                : ev.location?.type || "—";

            return (
              <div key={ev.uri} className="p-4">
                <div className="font-medium">{title}</div>
                <div className="text-sm text-gray-500">
                  {prettyDate(start)} – {prettyDate(end)}
                </div>
                {location && (
                  <div className="text-sm text-gray-500 mt-1">Location: {location}</div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
