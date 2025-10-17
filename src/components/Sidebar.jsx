// File: src/components/Sidebar.jsx
import { NavLink } from "react-router-dom";
import { useEffect, useMemo, useState } from "react";
import { routes } from "../routesConfig.js";
import { supabase } from "../lib/supabaseClient.js";
import useIsAdminAllowlist from "../hooks/useIsAdminAllowlist.js";
import Logo from "../assets/logo-tight.png";

/* Safe, widely-available Lucide icons */
import {
  Home as HomeIcon,
  Users,
  ListChecks as PipelineIcon,
  MessageSquare,
  Calendar as CalendarIcon,
  Settings as SettingsIcon,
  LifeBuoy,
  Megaphone,
  Bot,
  Phone,
  PhoneCall,
  BarChart3,
  Wrench,
  Globe2,
  Pencil,
  ExternalLink,
  Shield,
  Star,
  Bell, // ← NEW (for Enable Notifications on iOS)
} from "lucide-react";

/* --- Gradient stroke helper (indigo → purple → fuchsia) --- */
function GradientStrokeIcon({ Icon, id, className = "" }) {
  return (
    <Icon className={className} stroke={`url(#${id})`}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#6366f1" />
          <stop offset="50%" stopColor="#a855f7" />
          <stop offset="100%" stopColor="#d946ef" />
        </linearGradient>
      </defs>
    </Icon>
  );
}

/* Icon map */
const ICONS = {
  Home: HomeIcon,
  Leads: Users,
  Pipeline: PipelineIcon,
  Messages: MessageSquare,
  Calendar: CalendarIcon,

  // Productivity & Communication
  "Power Dialer": Phone,
  "Smart Dialer": PhoneCall,
  "Messaging Settings": SettingsIcon,
  Mailing: Megaphone,
  "AI Rebuttal Helper": Bot,
  "Call Recorder": PhoneCall,
  Contacts: Users,
  "Lead Rescue": LifeBuoy,

  // Insights & Tools
  Reports: BarChart3,
  "Agent Tools": Wrench,

  // Agent site
  "View My Agent Site": Globe2,
  "Edit Agent Site": Pencil,
  Reviews: Star,

  // Teams
  "My Teams": Users,

  // Bottom
  "Enable Notifications on iOS": Bell, // ← NEW
  Settings: SettingsIcon,
  Support: LifeBuoy,

  // Admin
  "Admin Console": Shield,
};

function ItemLink({ r, onNavigate }) {
  const Icon = ICONS[r.label] || null;
  const gradId = `remie-grad-${(r.key || r.label).replace(/\s+/g, "-").toLowerCase()}`;
  return (
    <NavLink
      to={r.path}
      onClick={onNavigate}
      className={({ isActive }) =>
        [
          "group flex items-center gap-2 px-3 py-2 rounded-md transition",
          isActive ? "bg-white/10 text-white" : "text-white/80 hover:bg-white/10 hover:text-white",
        ].join(" ")
      }
    >
      {Icon ? (
        <GradientStrokeIcon Icon={Icon} id={gradId} className="w-4 h-4 shrink-0 transition group-hover:scale-105" />
      ) : (
        <span className="w-4" />
      )}
      <span>{r.label}</span>
    </NavLink>
  );
}

/* View/Preview My Agent Site */
function ViewAgentSiteLink() {
  const [slug, setSlug] = useState("");
  const [published, setPublished] = useState(false);
  const [loading, setLoading] = useState(true);

  async function fetchProfile() {
    try {
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth?.user?.id;
      if (!uid) {
        setSlug("");
        setPublished(false);
        return;
      }
      const { data } = await supabase
        .from("agent_profiles")
        .select("slug, published")
        .eq("user_id", uid)
        .maybeSingle();

      if (data) {
        setSlug(data.slug || "");
        setPublished(!!data.published);
      } else {
        setSlug("");
        setPublished(false);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let isMounted = true;
    (async () => {
      await fetchProfile();

      const channel = supabase
        .channel("agent_profiles_self")
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "agent_profiles" },
          async () => {
            if (!isMounted) return;
            await fetchProfile();
          }
        )
        .subscribe();

      const onStorage = (e) => {
        if (e.key === "agent_profile_refresh") fetchProfile();
      };
      window.addEventListener("storage", onStorage);

      return () => {
        isMounted = false;
        try { supabase.removeChannel?.(channel); } catch {}
        window.removeEventListener("storage", onStorage);
      };
    })();
  }, []);

  if (loading) {
    return (
      <div className="block rounded-lg px-3 py-2 text-white/40 cursor-default">
        View My Agent Site…
      </div>
    );
  }

  if (!slug) {
    return (
      <NavLink
        to="/app/agent/showcase"
        className="flex items-center gap-2 rounded-lg px-3 py-2 text-amber-300/90 hover:bg-white/5"
        title="Finish setup to generate your public link"
      >
        <ExternalLink className="h-4 w-4" />
        <span>Finish Agent Site Setup</span>
      </NavLink>
    );
  }

  const href = `/a/${slug}`;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="flex items-center gap-2 rounded-lg px-3 py-2 text-white/80 hover:bg-white/5 hover:text-white"
      title={published ? "Open your public agent page" : "Open preview (publish in the wizard)"}
    >
      <ExternalLink className="h-4 w-4" />
      <span>{published ? "View My Agent Site" : "Preview My Agent Site"}</span>
    </a>
  );
}

/* Grouped sections */
function Group({ title, items, storageKey, onNavigate }) {
  const [open, setOpen] = useState(true);

  useEffect(() => {
    const saved = localStorage.getItem(storageKey);
    if (saved !== null) setOpen(saved === "1");
  }, [storageKey]);

  if (!items.length) return null;

  return (
    <div className="mt-4">
      <button
        onClick={() => {
          const next = !open;
          setOpen(next);
          localStorage.setItem(storageKey, next ? "1" : "0");
        }}
        className="w-full text-left text-xs uppercase tracking-wide text-white/50 hover:text-white/80 px-3 py-2"
      >
        {title}
        <span className="float-right text-white/40">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <nav className="mt-1 space-y-1">
          {items.map((r) => (
            <ItemLink key={r.key} r={r} onNavigate={onNavigate} />
          ))}
        </nav>
      )}
    </div>
  );
}

function SimpleList({ items, onNavigate }) {
  if (!items.length) return null;
  return (
    <nav className="mt-2 space-y-1">
      {items.map((r) => (
        <ItemLink key={r.key} r={r} onNavigate={onNavigate} />
      ))}
    </nav>
  );
}

/* Sidebar Content */
function SidebarContent({ onNavigate }) {
  const { isAdmin } = useIsAdminAllowlist();

  const sections = useMemo(() => {
    const visible = routes.filter((r) => r.showInSidebar && r.path?.startsWith("/app"));
    const by = (s) => visible.filter((r) => r.section === s);
    return {
      top: by("top"),
      productivity: by("productivity"),
      insightsTools: by("insights_tools"),
      agentSite: by("agent_site"),
      teams: by("teams"),
      bottom: by("bottom"),
    };
  }, []);

  const hideAdminOnly = (arr) => arr.filter((r) => !r.adminOnly || isAdmin);

  let bottomItems = hideAdminOnly(sections.bottom);

  // If admin, prepend Admin Console
  if (isAdmin) {
    bottomItems = [{ key: "admin-console", path: "/app/admin", label: "Admin Console" }, ...bottomItems];
  }

  // Ensure Support exists
  const hasSupport = bottomItems.some((r) => r.key === "support");
  if (!hasSupport) bottomItems.push({ key: "support", path: "/app/support", label: "Support" });

  // 🔔 Place "Enable Notifications on iOS" directly ABOVE "Settings"
  const idxEnable = bottomItems.findIndex((r) => r.key === "enable-notifications-ios");
  const idxSettings = bottomItems.findIndex((r) => r.key === "settings");
  if (idxEnable !== -1 && idxSettings !== -1 && idxEnable !== idxSettings - 1) {
    const [enableItem] = bottomItems.splice(idxEnable, 1);
    bottomItems.splice(idxSettings, 0, enableItem);
  }

  return (
    <>
      {/* Brand */}
      <a
        href="https://remiecrm.com"
        target="_blank"
        rel="noopener noreferrer"
        className="p-4 flex items-center gap-3 border-b border-white/10"
      >
        <div className="grid h-9 w-9 place-items-center">
          <img src={Logo} alt="Logo" className="h-9 w-9 object-contain" />
        </div>
        <div className="font-semibold">Remie CRM</div>
      </a>

      <div className="p-3 text-sm">
        <SimpleList items={hideAdminOnly(sections.top)} onNavigate={onNavigate} />
        <Group
          title="Productivity & Communication"
          items={hideAdminOnly(sections.productivity)}
          storageKey="grp_productivity"
          onNavigate={onNavigate}
        />
        <Group
          title="Insights & Tools"
          items={hideAdminOnly(sections.insightsTools)}
          storageKey="grp_insights_tools"
          onNavigate={onNavigate}
        />

        <div className="pt-2 mt-2 border-t border-white/10" />
        <ViewAgentSiteLink />
        <Group
          title="Agent Site Management"
          items={hideAdminOnly(sections.agentSite)}
          storageKey="grp_agent_site"
          onNavigate={onNavigate}
        />

        <div className="pt-2 mt-2 border-t border-white/10" />
        <Group
          title="Teams"
          items={hideAdminOnly(sections.teams)}
          storageKey="grp_teams"
          onNavigate={onNavigate}
        />
      </div>

      <div className="mt-6 border-t border-white/10 p-2">
        <div className="text-xs uppercase tracking-wide text-white/50 px-3 pb-2">
          Account &amp; Help
        </div>
        <SimpleList items={bottomItems} onNavigate={onNavigate} />
      </div>
    </>
  );
}

/* Desktop + Mobile wrappers */
export default function Sidebar({ mobileOpen = false, setMobileOpen = () => {} }) {
  const desktopAside = (
    <aside className="relative z-10 hidden md:flex md:flex-col border-r border-white/10 bg-black/30 h-screen">
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain no-scrollbar">
        <SidebarContent />
      </div>
    </aside>
  );

  const close = () => setMobileOpen(false);

  const mobileAside = (
    <>
      <div
        className={`fixed inset-0 z-40 bg-black/50 backdrop-blur-sm transition-opacity md:hidden ${
          mobileOpen ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        }`}
        onClick={close}
      />
      <div
        className={`fixed inset-y-0 left-0 z-50 w-[80%] max-w-[280px] bg-neutral-950 border-r border-white/10 md:hidden
        h-screen flex flex-col transition-transform duration-300 ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain no-scrollbar">
          <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
            <div className="flex items-center gap-2">
              <img src={Logo} alt="Logo" className="h-7 w-7 object-contain" />
              <div className="font-semibold">Remie CRM</div>
            </div>
          </div>

          <SidebarContent onNavigate={close} />
        </div>
      </div>
    </>
  );

  return (
    <>
      {desktopAside}
      {mobileAside}
    </>
  );
}
