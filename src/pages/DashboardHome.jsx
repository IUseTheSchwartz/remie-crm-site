// File: src/pages/DashboardHome.jsx
import { useEffect, useMemo, useState } from "react";
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

  // --- Discord: invite + deep link helpers ---
  const INVITE = useMemo(
    () => import.meta.env?.VITE_DISCORD_INVITE_URL || "https://discord.gg/your-invite-code",
    []
  );

  const deepLink = useMemo(() => {
    try {
      const url = new URL(INVITE);
      const code =
        url.hostname.includes("discord.gg")
          ? url.pathname.replace("/", "")
          : url.pathname.split("/").pop();
      return code ? `discord://invite/${code}` : INVITE;
    } catch {
      return INVITE;
    }
  }, [INVITE]);

  const [copied, setCopied] = useState(false);
  async function copyInvite() {
    try {
      await navigator.clipboard.writeText(INVITE);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  }

  // Optional: allow dismissing the Discord panel (mirrors previous video UX)
  const [showDiscordPanel, setShowDiscordPanel] = useState(() => {
    try {
      return localStorage.getItem("remiecrm_discord_panel_dismissed") !== "1";
    } catch {
      return true;
    }
  });
  function dismissDiscordPanel() {
    try {
      localStorage.setItem("remiecrm_discord_panel_dismissed", "1");
    } catch {}
    setShowDiscordPanel(false);
  }

  // snapshot + refresh logic
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

      {/* Discord Panel (replaces video) */}
      {showDiscordPanel && (
        <Card
          title="Join our Discord"
          right={
            <button
              onClick={dismissDiscordPanel}
              className="rounded-lg px-2 py-1 border border-white/10 bg-white/5 hover:bg-white/10"
              title="Hide this panel"
            >
              Dismiss
            </button>
          }
        >
          <div className="mb-3 text-white/70">
            We’ve moved onboarding videos and support to Discord. Join to watch step-by-step
            setup, get updates, and chat with the team.
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <a
              href={INVITE}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center rounded-xl bg-white text-black px-4 py-2 font-medium hover:bg-white/90"
            >
              Join Discord
            </a>

            <a
              href={deepLink}
              className="inline-flex items-center rounded-xl border border-white/15 bg-white/5 px-4 py-2 text-sm hover:bg-white/10"
            >
              Open in Discord app
            </a>

            <button
              type="button"
              onClick={copyInvite}
              className="inline-flex items-center rounded-xl border border-white/15 bg-white/5 px-4 py-2 text-sm hover:bg-white/10"
            >
              {copied ? "Copied!" : "Copy invite link"}
            </button>
          </div>

          <div className="mt-2 text-xs text-white/50">
            Tip: If the app link doesn’t open, use the Join button or paste the invite into Discord.
          </div>
        </Card>
      )}
    </div>
  );
}
