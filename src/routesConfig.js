// File: src/routesConfig.js
// Minimal, backwards-compatible update:
// - Adds `section` to control sidebar grouping
// - Renames "Tools" -> "Agent Tools" (UI label only; path unchanged)
// - Moves Settings/Support to bottom section via `section: "bottom"`

import DashboardHome from "./pages/DashboardHome.jsx";
import LeadsPage from "./pages/LeadsPage.jsx";
import PipelinePage from "./pages/PipelinePage.jsx";
import ReportsPage from "./pages/ReportsPage.jsx";
import CalendarPage from "./pages/CalendarPage.jsx";
import SettingsPage from "./pages/SettingsPage.jsx";
import AgentShowcase from "./pages/AgentShowcase.jsx";
import ToolsPage from "./pages/ToolsPage.jsx";
import MessagesPage from "./pages/MessagesPage.jsx";
import MailingPage from "./pages/MailingPage.jsx";
import MessagingSettings from "./pages/MessagingSettings.jsx";
import SupportPage from "./pages/SupportPage.jsx";
import TermsPage from "./pages/legal/Terms.jsx";
import PrivacyPage from "./pages/legal/Privacy.jsx";

// ---- Team pages ----
import MyTeams from "./pages/MyTeams.jsx";
import TeamManagement from "./pages/TeamManagement.jsx";
import TeamDashboard from "./pages/TeamDashboard.jsx";

// ---- Admin-only Support Inbox (wrapper with ProtectedRoute) ----
import AdminSupportInbox from "./pages/AdminSupportInbox.jsx";

// ---- AI Rebuttal Helper ----
import RebuttalChat from "./pages/RebuttalChat.jsx";

// ---- Call Recorder ----
import CallRecorder from "./pages/CallRecorder.jsx";

// SECTION KEYS used by Sidebar:
// "top"                      → Top-Level (Most Used Daily)
// "productivity"             → Productivity & Communication
// "insights_tools"           → Insights & Tools
// "agent_site"               → Agent Site Management
// "teams"                    → Teams
// "bottom"                   → Account & Help (footer area)
// anything else or omitted   → hidden from sidebar unless showInSidebar true with known section

export const routes = [
  // Top-level (Most Used Daily)
  { key: "home",     path: "/app",            label: "Home",     component: DashboardHome, index: true,  showInSidebar: true, section: "top" },
  { key: "leads",    path: "/app/leads",      label: "Leads",    component: LeadsPage,                    showInSidebar: true, section: "top" },
  { key: "pipeline", path: "/app/pipeline",   label: "Pipeline", component: PipelinePage,                 showInSidebar: true, section: "top" },
  { key: "messages", path: "/app/messages",   label: "Messages", component: MessagesPage,                 showInSidebar: true, section: "top" },
  { key: "calendar", path: "/app/calendar",   label: "Calendar", component: CalendarPage,                 showInSidebar: true, section: "top" },

  // Productivity & Communication
  { key: "msgSettings", path: "/app/messaging-settings", label: "Messaging Settings", component: MessagingSettings, showInSidebar: true, section: "productivity" },
  { key: "mailing",     path: "/app/mailing",             label: "Mailing",             component: MailingPage,     showInSidebar: true, section: "productivity" },
  { key: "rebuttal",    path: "/app/rebuttal",            label: "AI Rebuttal Helper", component: RebuttalChat,    showInSidebar: true, section: "productivity" },
  { key: "call-recorder", path: "/app/call-recorder",     label: "Call Recorder",      component: CallRecorder,    showInSidebar: true, section: "productivity" },

  // Insights & Tools
  { key: "reports",  path: "/app/reports",  label: "Reports",     component: ReportsPage,  showInSidebar: true, section: "insights_tools" },
  // UI shows "Agent Tools" but keeps your existing /app/tools route
  { key: "tools",    path: "/app/tools",    label: "Agent Tools", component: ToolsPage,    showInSidebar: true, section: "insights_tools" },

  // Agent Site Management
  { key: "agentShowcase", path: "/app/agent/showcase", label: "Edit Agent Site", component: AgentShowcase, showInSidebar: true, section: "agent_site" },
  // (Optional) If you have a “View My Agent Site” route/page, add it here with section: "agent_site"

  // Teams
  { key: "my-teams",       path: "/app/teams",                 label: "My Teams",       component: MyTeams,        showInSidebar: true,  section: "teams" },
  { key: "team-manage",    path: "/app/team/manage/:teamId",   label: "Manage Team",    component: TeamManagement, showInSidebar: false, section: "teams" },
  { key: "team-dashboard", path: "/app/team/:teamId/dashboard",label: "Team Dashboard", component: TeamDashboard,  showInSidebar: false, section: "teams" },

  // Bottom (Account & Help)
  { key: "settings", path: "/app/settings", label: "Settings", component: SettingsPage, showInSidebar: true, section: "bottom" },
  { key: "support",  path: "/app/support",  label: "Support",  component: SupportPage,  showInSidebar: true, section: "bottom" },

  // Admin-only (hidden from sidebar)
  {
    key: "support-inbox",
    path: "/app/support-inbox",
    label: "Support Inbox",
    component: AdminSupportInbox,
    showInSidebar: false,
    section: "hidden",
  },

  // Legal (hidden from sidebar)
  { key: "terms",   path: "/legal/terms",   label: "Terms of Service", component: TermsPage,   showInSidebar: false, section: "hidden" },
  { key: "privacy", path: "/legal/privacy", label: "Privacy Policy",   component: PrivacyPage, showInSidebar: false, section: "hidden" },
];
