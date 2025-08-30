// File: src/pages/CalendarPage.jsx
import { useEffect, useState } from "react";

function pretty(iso) {
  try {
    return new Date(iso).toLocaleString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export default function CalendarPage() {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  useEffect(() => {
    (async () => {
      setLoading(true);
      setErr("");
      try {
        const res = await fetch("/.netlify/functions/calendly-events");
        if (!res.ok) throw new Error(await res.text());
        const json = await res.json();
        setEvents(json?.events?.collection || []);
      } catch (e) {
        console.error(e);
        setErr("Could not load events.");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
      <div className="mb-3 text-sm font-semibold">Upcoming meetings</div>

      {loading && <div className="text-sm text-white/60">Loading…</div>}
      {!loading && err && <div className="text-sm text-rose-300">{err}</div>}
      {!loading && !err && events.length === 0 && (
        <div className="text-sm text-white/60">No upcoming meetings.</div>
      )}

      {!loading && !err && events.length > 0 && (
        <div className="divide-y divide-white/10">
          {events.map((ev) => (
            <div key={ev.uri} className="py-3">
              <div className="text-sm font-medium text-white">
                {ev.name || "Scheduled event"}
              </div>
              <div className="text-xs text-white/70">
                {pretty(ev.start_time)} – {pretty(ev.end_time)}
              </div>
              {ev.location?.join_url && (
                <a
                  href={ev.location.join_url}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 inline-block text-xs text-indigo-300 underline"
                >
                  Join link
                </a>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
