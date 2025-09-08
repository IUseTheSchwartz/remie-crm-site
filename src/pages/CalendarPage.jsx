// File: src/pages/CalendarPage.jsx
import { useEffect, useState, useMemo } from "react";
import { supabase } from "../lib/supabaseClient.js";

export default function CalendarPage() {
  const [userId, setUserId] = useState(null);

  // Calendly
  const [loading, setLoading] = useState(true);
  const [events, setEvents] = useState([]);
  const [err, setErr] = useState("");

  // Follow-ups (pipeline)
  const [fuLoading, setFuLoading] = useState(true);
  const [followUps, setFollowUps] = useState([]);
  const [fuErr, setFuErr] = useState("");

  // ---------------------------
  // Helpers
  // ---------------------------
  const prettyDate = (iso) => {
    if (!iso) return "—";
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  };

  const pickFollowUpDate = (row) => {
    // Try common column names in priority order; add more if your schema differs.
    const cand =
      row?.next_follow_up_at ||
      row?.next_followup_at ||
      row?.next_touch ||
      row?.follow_up_date ||
      row?.followup_date ||
      row?.followup_at ||
      null;
    return cand ? new Date(cand) : null;
  };

  // ---------------------------
  // Load current user (shared)
  // ---------------------------
  useEffect(() => {
    let cancel = false;

    (async () => {
      const { data, error } = await supabase.auth.getUser();
      if (cancel) return;
      if (error || !data?.user?.id) {
        setErr(error?.message || "Not authenticated");
        setLoading(false);
        setFuErr(error?.message || "Not authenticated");
        setFuLoading(false);
        return;
      }
      setUserId(data.user.id);
    })();

    return () => {
      cancel = true;
    };
  }, []);

  // ---------------------------
  // Load Calendly events (unchanged logic)
  // ---------------------------
  useEffect(() => {
    if (!userId) return;
    let cancel = false;

    (async () => {
      setLoading(true);
      setErr("");
      setEvents([]);

      try {
        const res = await fetch(
          `/.netlify/functions/calendly-events?uid=${encodeURIComponent(userId)}&count=50`
        );
        if (!res.ok) {
          const t = await res.text();
          throw new Error(t || `HTTP ${res.status}`);
        }
        const payload = await res.json();
        const list = Array.isArray(payload?.collection) ? payload.collection : [];
        if (!cancel) setEvents(list);
      } catch (e) {
        if (!cancel) setErr(e.message || "Failed to load events");
      } finally {
        if (!cancel) setLoading(false);
      }
    })();

    return () => {
      cancel = true;
    };
  }, [userId]);

  // ---------------------------
  // Load upcoming Follow-Ups from pipeline
  // ---------------------------
  useEffect(() => {
    if (!userId) return;
    let cancel = false;

    (async () => {
      setFuLoading(true);
      setFuErr("");
      setFollowUps([]);

      try {
        // Pull reasonable fields; add any others you want to display.
        // If you use a different owner field, change 'owner_id' below.
        const { data, error } = await supabase
          .from("leads")
          .select(
            `
              id,
              full_name,
              first_name,
              last_name,
              phone,
              stage,
              next_follow_up_at,
              next_followup_at,
              next_touch,
              follow_up_date,
              followup_date,
              followup_at,
              notes
            `
          )
          .eq("owner_id", userId);

        if (error) throw error;

        const now = new Date();
        const rows = (data || [])
          .map((r) => {
            const when = pickFollowUpDate(r);
            return { ...r, _when: when };
          })
          .filter((r) => r._when && r._when >= now) // only upcoming
          .sort((a, b) => a._when - b._when)
          .slice(0, 50); // cap the list

        if (!cancel) setFollowUps(rows);
      } catch (e) {
        if (!cancel) setFuErr(e.message || "Failed to load follow-ups");
      } finally {
        if (!cancel) setFuLoading(false);
      }
    })();

    return () => {
      cancel = true;
    };
  }, [userId]);

  const followUpsEmpty = useMemo(() => !fuLoading && !fuErr && followUps.length === 0, [fuLoading, fuErr, followUps]);

  // ---------------------------
  // Render
  // ---------------------------
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Schedule</h1>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left: Upcoming Calendly meetings (existing behavior) */}
        <div className="space-y-3">
          <h2 className="text-lg font-medium">Upcoming meetings (Calendly)</h2>

          {loading && <div className="rounded-2xl border p-4">Loading…</div>}

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
                const location =
                  ev.location?.type === "physical"
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
                      <div className="text-sm text-gray-500 mt-1">
                        Location: {location}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Right: Upcoming Follow-Ups from pipeline */}
        <div className="space-y-3">
          <h2 className="text-lg font-medium">Upcoming follow-ups (Pipeline)</h2>

          {fuLoading && <div className="rounded-2xl border p-4">Loading…</div>}

          {!fuLoading && fuErr && (
            <div className="rounded-2xl border p-4 text-red-500">
              Could not load follow-ups. {fuErr}
            </div>
          )}

          {followUpsEmpty && (
            <div className="rounded-2xl border p-4 text-gray-400">
              No upcoming follow-ups.
            </div>
          )}

          {!fuLoading && !fuErr && followUps.length > 0 && (
            <div className="rounded-2xl border divide-y">
              {followUps.map((row) => {
                const name =
                  row.full_name ||
                  [row.first_name, row.last_name].filter(Boolean).join(" ") ||
                  "Lead";
                const whenStr = prettyDate(row._when?.toISOString?.() || row._when);
                return (
                  <div key={row.id} className="p-4">
                    <div className="font-medium">{name}</div>
                    <div className="text-sm text-gray-500">{whenStr}</div>
                    <div className="text-xs text-gray-500 mt-1">
                      Stage: {row.stage || "—"}
                      {row.phone ? ` • ${row.phone}` : ""}
                    </div>
                    {row.notes ? (
                      <div className="text-sm text-gray-600 mt-2 line-clamp-2">
                        {row.notes}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
