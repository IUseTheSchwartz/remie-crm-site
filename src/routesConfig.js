// File: src/routesConfig.js
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

// ---- Team pages (NEW) ----
import MyTeams from "./pages/MyTeams.jsx";
import TeamManagement from "./pages/TeamManagement.jsx";
import TeamDashboard from "./pages/TeamDashboard.jsx";

// ---- Admin-only Support Inbox (wrapper with ProtectedRoute) ----
import AdminSupportInbox from "./pages/AdminSupportInbox.jsx";

// ---- AI Rebuttal Helper (NEW) ----
import RebuttalChat from "./pages/RebuttalChat.jsx";

export const routes = [
  { key: "home",     path: "/app",            label: "Home",     component: DashboardHome, index: true,  showInSidebar: true, group: "main" },
  { key: "leads",    path: "/app/leads",      label: "Leads",    component: LeadsPage,                    showInSidebar: true, group: "main" },
  { key: "pipeline", path: "/app/pipeline",   label: "Pipeline", component: PipelinePage,                 showInSidebar: true, group: "main" },
  { key: "reports",  path: "/app/reports",    label: "Reports",  component: ReportsPage,                  showInSidebar: true, group: "main" },
  { key: "messages", path: "/app/messages",   label: "Messages", component: MessagesPage,                 showInSidebar: true, group: "main" },
  { key: "msgSettings", path: "/app/messaging-settings", label: "Messaging Settings", component: MessagingSettings, showInSidebar: true, group: "main" },
  { key: "mailing",  path: "/app/mailing",    label: "Mailing",  component: MailingPage,                  showInSidebar: true, group: "main" },
  { key: "calendar", path: "/app/calendar",   label: "Calendar", component: CalendarPage,                 showInSidebar: true, group: "main" },
  { key: "tools",    path: "/app/tools",      label: "Tools",    component: ToolsPage,                    showInSidebar: true, group: "main" },

  { key: "settings", path: "/app/settings",   label: "Settings", component: SettingsPage,                 showInSidebar: true, group: "main" },

  { key: "agentShowcase", path: "/app/agent/showcase", label: "Edit Agent Site", component: AgentShowcase, showInSidebar: true, group: "agent" },

  { key: "support", path: "/app/support", label: "Support", component: SupportPage, showInSidebar: true, group: "agent" },

  // Admin-only Support Inbox (hidden from sidebar; show conditionally in Sidebar)
  {
    key: "support-inbox",
    path: "/app/support-inbox",
    label: "Support Inbox",
    component: AdminSupportInbox,
    showInSidebar: false,
    group: "agent",
  },

  { key: "my-teams", path: "/app/teams", label: "My Teams", component: MyTeams, showInSidebar: true, group: "teams" },
  { key: "team-manage", path: "/app/team/manage/:teamId", label: "Manage Team", component: TeamManagement, showInSidebar: false, group: "teams" },
  { key: "team-dashboard", path: "/app/team/:teamId/dashboard", label: "Team Dashboard", component: TeamDashboard, showInSidebar: false, group: "teams" },

  // ---- NEW: AI Rebuttal Helper ----
  { key: "rebuttal", path: "/app/rebuttal", label: "AI Rebuttal Helper", component: RebuttalChat, showInSidebar: true, group: "tools" },

  { key: "terms",   path: "/legal/terms",   label: "Terms of Service", component: TermsPage,   showInSidebar: false, group: "legal" },
  { key: "privacy", path: "/legal/privacy", label: "Privacy Policy",   component: PrivacyPage, showInSidebar: false, group: "legal" },
];
