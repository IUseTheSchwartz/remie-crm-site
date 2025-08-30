import { useEffect, useState, useMemo } from "react";
import { InlineWidget } from "react-calendly";
import { supabase } from "../lib/supabaseClient";

// Small list item
function Row({ label, value }) {
  return (
    <div className="flex justify-between items-center py-2 border-b border-white/10 text-sm">
      <div className="text-white/80">{label}</div>
      <div className="text-white/60">{value}</div>
    </div>
  );
}

export default function CalendarPage() {
  const [calendlyUrl, setCalendlyUrl] = useState("");     // from Supabase user profile
  const [loadingProfile, setLoadingProfile] = useState(true);

  const [events, setEvents] = useState([]);
  const [loadingEvents, setLoadingEvents] = useState(true);
  const [err, setErr] = useState("");

  // 1) Load the user's calendly_url from your agent_profiles table
  useEffect(() => {
    (async () => {
      try {
        const { data: auth } = await supabase.auth.getUser();
        const uid = auth?.user?.id;
        if (!uid) return;

        const { data, error } = await supabase
          .from("agent_profiles")
          .select("calendly_url")
          .eq("user_id", uid)
          .maybeSingle();

        if (!error && data?.calendly_url) setCalendlyUrl(data.calendly_url);
      } catch (e) {
        console.error(e);
      } finally {
        setLoadingProfile(false);
      }
    })();
  }, []);

  // 2) Fetch upcoming meetings (from our Netlify function)
  useEffect(() => {
    (async () => {
      setLoadingEvents(true);
      setErr("");
      try {
        const res = await fetch("/.netlify/functions/calendly-events");
        if (!res.ok) throw new Error(await res.text());
        const json = await res.json();
        const list = json?.events?.collection || [];
        setEvents(list);
      } catch (e) {
        console.error(e);
        setErr("Could not load events.");
      } finally {
        setLoadingEvents(false);
      }
    })();
  }, []);

  const pretty = (iso) =>
    new Date(iso).toLocaleString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });

  return (
    <div className="grid gap-6 md:grid-cols-2">
      {/* Left: Upcoming meetings */}
      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
        <div className="mb-2 text-sm font-semibold">Upcoming meetings</div>
        {loadingEvents ? (
          <div className="text-white/60 text-sm">Loading…</div>
        ) : err ? (
          <div className="text-rose-300 text-sm">{err}</div>
        ) : events.length === 0 ? (
          <div className="text-white/60 text-sm">No upcoming meetings.</div>
        ) : (
          <div className="divide-y divide-white/10">
            {events.map((ev) => (
              <div key={ev.uri} className="py-3">
                <div className="text-white font-medium text-sm">
                  {ev.name || "Scheduled event"}
                </div>
                <div className="text-white/70 text-xs">
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

      {/* Right: Book new meetings */}
      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
        <div className="mb-2 text-sm font-semibold">Book a new meeting</div>
        {loadingProfile ? (
          <div className="text-white/60 text-sm">Loading…</div>
        ) : calendlyUrl ? (
          <div className="h-[720px] rounded-lg overflow-hidden">
            <InlineWidget
              url={calendlyUrl}
              styles={{ height: "100%" }}
              pageSettings={{
                backgroundColor: "0b0b0b",
                textColor: "ffffff",
                primaryColor: "6366f1",
              }}
            />
          </div>
        ) : (
          <div className="text-sm text-white/70">
            Add your Calendly link in <span className="font-medium">Settings</span> to enable booking here.
          </div>
        )}
      </div>
    </div>
  );
}
