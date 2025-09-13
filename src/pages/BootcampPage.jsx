import { useEffect, useMemo, useState } from "react";
import { Search, GraduationCap, CheckCircle2, CirclePlay, ExternalLink } from "lucide-react";

/* ---------------- Helpers ---------------- */
function getYouTubeId(input) {
  // Accepts full URLs or raw IDs
  if (!input) return "";
  const url = String(input).trim();
  const idMatch =
    url.match(/(?:v=|youtu\.be\/|embed\/)([A-Za-z0-9_-]{11})/) ||
    url.match(/^([A-Za-z0-9_-]{11})$/);
  return idMatch ? idMatch[1] : "";
}

function YouTubeEmbed({ id }) {
  if (!id) return null;
  return (
    <div className="relative w-full pt-[56.25%] rounded-xl overflow-hidden shadow">
      <iframe
        className="absolute inset-0 w-full h-full"
        src={`https://www.youtube.com/embed/${id}`}
        title="Bootcamp Video"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
        allowFullScreen
      />
    </div>
  );
}

/* ---------------- Bootcamp Catalog ----------------
   Add/edit videos here. Each item can target a CRM page via `topic`.
   Suggested topics: "Dashboard", "Leads", "Pipeline", "Messages",
   "Calendar", "Contacts", "Agent Showcase", "Reports", "Settings", "Recorder"
--------------------------------------------------- */
const TUTORIALS = [
  {
    id: "bc-dashboard-01",
    title: "Welcome & CRM Overview",
    yt: "https://youtu.be/dQw4w9WgXcQ", // <-- replace with your real video
    duration: "3:42",
    topic: "Dashboard",
    notes: "Quick tour of navigation, subscriptions, and layout.",
  },
  {
    id: "bc-leads-01",
    title: "Leads Page: Import & Fields",
    yt: "https://youtu.be/VIDEOID11111",
    duration: "6:10",
    topic: "Leads",
    notes: "CSV import, manual add, key columns, dedupe tips.",
  },
  {
    id: "bc-pipeline-01",
    title: "Pipeline: Stages & Follow-ups",
    yt: "https://youtu.be/VIDEOID22222",
    duration: "5:28",
    topic: "Pipeline",
    notes: "Drag & drop, scheduling, reminders, and filters.",
  },
  {
    id: "bc-messages-01",
    title: "Messages: Send, Templates, Tags",
    yt: "https://youtu.be/VIDEOID33333",
    duration: "7:02",
    topic: "Messages",
    notes: "Outbound/inbound flow, templates, opt-outs, delivery tips.",
  },
  {
    id: "bc-calendar-01",
    title: "Calendar: Appointments & Auto-Reminders",
    yt: "https://youtu.be/VIDEOID44444",
    duration: "4:55",
    topic: "Calendar",
    notes: "Booking links, reminders, removing tags at appointment time.",
  },
  {
    id: "bc-contacts-01",
    title: "Contacts: Tags, Unsubscribes, Lists",
    yt: "https://youtu.be/VIDEOID55555",
    duration: "5:17",
    topic: "Contacts",
    notes: "Building audiences with tags, removing via replies.",
  },
  {
    id: "bc-showcase-01",
    title: "Agent Showcase: Profile & Media",
    yt: "https://youtu.be/VIDEOID66666",
    duration: "4:21",
    topic: "Agent Showcase",
    notes: "Step 2 uploads, skipping, CTA links.",
  },
  {
    id: "bc-reports-01",
    title: "Reports: Top Producers & Metrics",
    yt: "https://youtu.be/VIDEOID77777",
    duration: "3:58",
    topic: "Reports",
    notes: "Interpreting dashboards & leaderboards.",
  },
  {
    id: "bc-settings-01",
    title: "Settings: Messaging, Billing, Team",
    yt: "https://youtu.be/VIDEOID88888",
    duration: "6:33",
    topic: "Settings",
    notes: "Templates, wallet, numbers, and team seats.",
  },
  {
    id: "bc-recorder-01",
    title: "Call Recorder & Transcripts",
    yt: "https://youtu.be/VIDEOID99999",
    duration: "5:44",
    topic: "Recorder",
    notes: "Live transcription tips and saving recordings.",
  },
];

/* Build list of unique topics for filter dropdown */
const TOPICS = ["All", ...Array.from(new Set(TUTORIALS.map(t => t.topic)))].sort();

/* ---------------- Watched State (localStorage) ---------------- */
const STORAGE_KEY = "remiecrm_bootcamp_watched_v1";

function loadWatched() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}
function saveWatched(set) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(set)));
  } catch {}
}

/* ---------------- Page ---------------- */
export default function BootcampPage() {
  const [query, setQuery] = useState("");
  const [topic, setTopic] = useState("All");
  const [watched, setWatched] = useState(() => loadWatched());
  const [expanded, setExpanded] = useState(null); // which card is expanded

  useEffect(() => {
    saveWatched(watched);
  }, [watched]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return TUTORIALS.filter((t) => {
      const matchesTopic = topic === "All" || t.topic === topic;
      const matchesQuery =
        !q ||
        t.title.toLowerCase().includes(q) ||
        t.topic.toLowerCase().includes(q) ||
        (t.notes || "").toLowerCase().includes(q);
      return matchesTopic && matchesQuery;
    });
  }, [query, topic]);

  const progress = Math.round((watched.size / TUTORIALS.length) * 100);

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xl font-semibold">
            <GraduationCap className="w-6 h-6" />
            Bootcamp
          </div>
          <p className="text-sm text-white/60 mt-1">
            Short, focused videos for every page in your CRM.
          </p>
        </div>

        <div className="flex flex-col sm:flex-row gap-3">
          <div className="flex items-center gap-2 bg-white/5 border border-white/10 rounded-xl px-3 py-2">
            <Search className="w-4 h-4 shrink-0" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search tutorials…"
              className="bg-transparent outline-none text-sm w-56"
            />
          </div>

          <select
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            className="bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm"
          >
            {TOPICS.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Progress */}
      <div className="bg-white/5 border border-white/10 rounded-2xl p-4">
        <div className="flex items-center justify-between mb-2 text-sm">
          <span>Progress</span>
          <span className="text-white/70">{watched.size} / {TUTORIALS.length} watched ({progress}%)</span>
        </div>
        <div className="h-2 rounded-full bg-white/10 overflow-hidden">
          <div
            className="h-2 bg-gradient-to-r from-indigo-500 via-purple-500 to-fuchsia-500"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      {/* Grid */}
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {filtered.map((t) => {
          const vid = getYouTubeId(t.yt);
          const isWatched = watched.has(t.id);
          const isOpen = expanded === t.id;
          return (
            <div
              key={t.id}
              className="group bg-white/5 border border-white/10 rounded-2xl p-4 flex flex-col gap-3 hover:border-white/20 transition"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm uppercase tracking-wide text-white/60">{t.topic}</div>
                  <div className="font-semibold leading-snug">{t.title}</div>
                  <div className="text-xs text-white/60 mt-1">{t.duration}</div>
                </div>
                <button
                  onClick={() =>
                    setWatched((prev) => {
                      const next = new Set(prev);
                      if (next.has(t.id)) next.delete(t.id);
                      else next.add(t.id);
                      return next;
                    })
                  }
                  className={`inline-flex items-center gap-1 rounded-xl px-2 py-1 text-xs border ${
                    isWatched
                      ? "border-emerald-400/40 bg-emerald-500/10 text-emerald-300"
                      : "border-white/10 bg-white/5 text-white/80"
                  }`}
                  title={isWatched ? "Mark as unwatched" : "Mark as watched"}
                >
                  {isWatched ? <CheckCircle2 className="w-4 h-4" /> : <CirclePlay className="w-4 h-4" />}
                  {isWatched ? "Watched" : "Watch"}
                </button>
              </div>

              {/* Player (collapsed by default until you click the card footer button) */}
              {isOpen && <YouTubeEmbed id={vid} />}

              {/* Notes */}
              {t.notes && (
                <p className="text-sm text-white/70">{t.notes}</p>
              )}

              <div className="mt-auto flex items-center justify-between pt-2">
                <button
                  onClick={() => setExpanded(isOpen ? null : t.id)}
                  className="text-sm underline underline-offset-4 hover:opacity-80"
                >
                  {isOpen ? "Hide player" : "Show player"}
                </button>
                <a
                  href={`https://www.youtube.com/watch?v=${vid}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-sm hover:opacity-80"
                >
                  Open on YouTube <ExternalLink className="w-4 h-4" />
                </a>
              </div>
            </div>
          );
        })}
      </div>

      {/* Empty state */}
      {filtered.length === 0 && (
        <div className="text-center text-white/70 py-20">
          No tutorials match your search.
        </div>
      )}
    </div>
  );
}
