import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";

function pretty(iso) {
  try {
    return new Date(iso).toLocaleString(undefined, {
      weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    });
  } catch { return iso; }
}

export default function CalendarPage() {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [connected, setConnected] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true); setErr("");
      try {
        const session = (await supabase.auth.getSession()).data.session;
        if (!session) { setConnected(false); setLoading(false); return; }
        const res = await fetch("/.netlify/functions/calendly-events", {
          headers: { Authorization: `Bearer ${session.access_token}` },
        });
        const json = await res.json();
        if (json?.error === "not_connected") { setConnected(false); setEvents([]); }
        else { setConnected(true); setEvents(json?.events?.collection || []); }
      } catch (e) { console.error(e); setErr("Could not load events."); }
      finally { setLoading(false); }
    })();
  }, []);

  return (
    <div className="space-y-4">
      {!connected && (
        <div className="rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
          Calendly is not connected. Go to <span className="font-medium">Settings → Calendly</span> and click
          <span className="font-medium"> Connect Calendly</span>.
        </div>
      )}

      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
        <div className="mb-3 text-sm font-semibold">Upcoming meetings</div>

        {loading && <div className="text-sm text-white/60">Loading…</div>}
        {!loading && err && <div className="text-sm text-rose-300">{err}</div>}
        {!loading && !err && events.length === 0 && <div className="text-sm text-white/60">No upcoming meetings.</div>}

        {!loading && !err && events.length > 0 && (
          <div className="divide-y divide-white/10">
            {events.map((ev) => (
              <div key={ev.uri} className="py-3">
                <div className="text-sm font-medium text-white">{ev.name || "Scheduled event"}</div>
                <div className="text-xs text-white/70">{pretty(ev.start_time)} – {pretty(ev.end_time)}</div>
                {ev.location?.join_url && (
                  <a href={ev.location.join_url} target="_blank" rel="noreferrer" className="mt-1 inline-block text-xs text-indigo-300 underline">
                    Join link
                  </a>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
