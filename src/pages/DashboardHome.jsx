// File: src/pages/DashboardHome.jsx
import { useEffect, useState } from "react";
import NumberCard from "../components/NumberCard.jsx";
import { dashboardSnapshot, refreshDashboardSnapshot } from "../lib/stats.js";
import { supabase } from "../lib/supabaseClient.js";
import { useAuth } from "../auth.jsx";

function Card({ title, right, children }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 ring-1 ring-white/5">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-sm font-semibold">{title}</div>
        {right ? <div className="text-xs text-white/70">{right}</div> : null}
      </div>
      <div className="text-sm text-white/80">{children}</div>
    </div>
  );
}

export default function DashboardHome() {
  const { user } = useAuth();

  // --- Welcome video settings ---
  const YT_VIDEO_ID = "https://youtu.be/h4hUVnDB_SU"; // replace with your YouTube ID

  const [showVideo, setShowVideo] = useState(() => {
    try {
      return localStorage.getItem("remiecrm_welcome_video_dismissed") !== "1";
    } catch {
      return true;
    }
  });

  function dismissVideo() {
    try {
      localStorage.setItem("remiecrm_welcome_video_dismissed", "1");
    } catch {}
    setShowVideo(false);
  }

  // snapshot + refresh logic (unchanged)
  const [snap, setSnap] = useState(dashboardSnapshot());
  const [loading, setLoading] = useState(false);

  function getOptions() {
    return {
      user_id: user?.id || null,
      team_id: user?.app_metadata?.team_id || null,
    };
  }

  async function doRefresh(reason = "mount") {
    try {
      setLoading(true);
      const data = await refreshDashboardSnapshot(getOptions());
      setSnap(data);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let isMounted = true;
    doRefresh("mount");

    const WATCH = [
      { table: "leads", events: ["INSERT", "UPDATE", "DELETE"] },
      { table: "appointments", events: ["INSERT", "UPDATE", "DELETE"] },
      { table: "calendar_events", events: ["INSERT", "UPDATE", "DELETE"] },
      { table: "followups", events: ["INSERT", "UPDATE", "DELETE"] },
      { table: "pipeline_followups", events: ["INSERT", "UPDATE", "DELETE"] },
      { table: "pipeline_events", events: ["INSERT", "UPDATE", "DELETE"] },
    ];
    const channels = WATCH.map(({ table, events }) => {
      const ch = supabase.channel(`dash-${table}`);
      events.forEach((evt) => {
        ch.on("postgres_changes", { event: evt, schema: "public", table }, () => {
          if (!isMounted) return;
          doRefresh(`realtime:${table}:${evt}`);
        });
      });
      ch.subscribe();
      return ch;
    });

    const onStorage = () => isMounted && doRefresh("storage");
    window.addEventListener("storage", onStorage);

    const onCustom = () => isMounted && doRefresh("custom");
    window.addEventListener("stats:changed", onCustom);

    const onFocus = () => isMounted && doRefresh("focus");
    const onVis = () =>
      document.visibilityState === "visible" && isMounted && doRefresh("visible");
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVis);

    const poll = setInterval(() => isMounted && doRefresh("poll"), 60000);

    return () => {
      isMounted = false;
      clearInterval(poll);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("stats:changed", onCustom);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVis);
      channels.forEach((ch) => supabase.removeChannel(ch));
    };
  }, [user?.id, user?.app_metadata?.team_id]);

  const money = (n) =>
    Intl.NumberFormat(undefined, {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }).format(n || 0);

  const kpi = [
    { label: "Closed (today)", value: snap.today.closed, sub: `This month: ${snap.thisMonth.closed}` },
    { label: "Clients (today)", value: snap.today.clients, sub: `This month: ${snap.thisMonth.clients}` },
    { label: "Leads (today)", value: snap.today.leads, sub: `This week: ${snap.thisWeek.leads}` },
    { label: "Appointments (today)", value: snap.today.appointments, sub: `This week: ${snap.thisWeek.appointments}` },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div />
        <button
          onClick={() => doRefresh("button")}
          className="rounded-xl px-3 py-2 text-sm bg-white/10 hover:bg-white/15 border border-white/10 text-white"
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {/* KPI Cards */}
      <div className="grid gap-4 md:grid-cols-4">
        {kpi.map((x) => (
          <NumberCard key={x.label} label={x.label} value={x.value} sublabel={x.sub} />
        ))}
      </div>

      {/* Week/Month Cards */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card title="This Week">
          <div className="grid grid-cols-5 gap-3 text-sm">
            <NumberCard label="Closed" value={snap.thisWeek.closed} />
            <NumberCard label="Clients" value={snap.thisWeek.clients} />
            <NumberCard label="Leads" value={snap.thisWeek.leads} />
            <NumberCard label="Appts" value={snap.thisWeek.appointments} />
            <NumberCard label="Premium" value={money(snap.thisWeek.premium)} />
          </div>
        </Card>
        <Card title="This Month">
          <div className="grid grid-cols-5 gap-3 text-sm">
            <NumberCard label="Closed" value={snap.thisMonth.closed} />
            <NumberCard label="Clients" value={snap.thisMonth.clients} />
            <NumberCard label="Leads" value={snap.thisMonth.leads} />
            <NumberCard label="Appts" value={snap.thisMonth.appointments} />
            <NumberCard label="Premium" value={money(snap.thisMonth.premium)} />
          </div>
        </Card>
      </div>

      {/* Getting Started Video (now at bottom) */}
      {showVideo && YT_VIDEO_ID && (
        <Card
          title="Getting Started"
          right={
            <button
              onClick={dismissVideo}
              className="rounded-lg px-2 py-1 border border-white/10 bg-white/5 hover:bg-white/10"
              title="Hide this video"
            >
              Dismiss
            </button>
          }
        >
          <div className="mb-3 text-white/70">
            Watch this quick walkthrough to set up your account, connect messaging, and book your first appointments.
          </div>
          <div className="relative w-full overflow-hidden rounded-2xl border border-white/10 bg-black pt-[56.25%]">
            <iframe
              className="absolute inset-0 h-full w-full"
              src={`https://www.youtube.com/embed/${YT_VIDEO_ID}?rel=0&modestbranding=1`}
              title="Getting Started with RemieCRM"
              frameBorder="0"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
              allowFullScreen
            />
          </div>
          <div className="mt-2 text-xs text-white/60">
            Prefer YouTube?{" "}
            <a
              href={`https://www.youtube.com/watch?v=${YT_VIDEO_ID}`}
              target="_blank"
              rel="noreferrer"
              className="underline hover:text-white"
            >
              Open the video in a new tab
            </a>
            .
          </div>
        </Card>
      )}
    </div>
  );
}
