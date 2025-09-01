// File: src/routesConfig.js
import DashboardHome from "./pages/DashboardHome.jsx";
import LeadsPage from "./pages/LeadsPage.jsx";
import PipelinePage from "./pages/PipelinePage.jsx";
import ReportsPage from "./pages/ReportsPage.jsx";
import CalendarPage from "./pages/CalendarPage.jsx";
import SettingsPage from "./pages/SettingsPage.jsx";
import AgentShowcase from "./pages/AgentShowcase.jsx";
import ToolsPage from "./pages/ToolsPage.jsx";
import MailingPage from "./pages/MailingPage.jsx";

export const routes = [
  // Main section
  { key: "home",     path: "/app",            label: "Home",     component: DashboardHome, index: true,  showInSidebar: true, group: "main" },
  { key: "leads",    path: "/app/leads",      label: "Leads",    component: LeadsPage,                    showInSidebar: true, group: "main" },
  { key: "pipeline", path: "/app/pipeline",   label: "Pipeline", component: PipelinePage,                 showInSidebar: true, group: "main" },
  { key: "reports",  path: "/app/reports",    label: "Reports",  component: ReportsPage,                  showInSidebar: true, group: "main" },
  { key: "calendar", path: "/app/calendar",   label: "Calendar", component: CalendarPage,                 showInSidebar: true, group: "main" },
  { key: "settings", path: "/app/settings",   label: "Settings", component: SettingsPage,                 showInSidebar: true, group: "main" },
  { key: "tools",    path: "/app/tools",      label: "Tools",    component: ToolsPage,                    showInSidebar: true, group: "main" },

  // Mailing section
  { key: "mailing",  path: "/app/mailing",    label: "Mailing",  component: MailingPage,                  showInSidebar: true, group: "default" },

  // Agent section (below divider)
  { key: "agentShowcase", path: "/app/agent/showcase", label: "Edit Agent Site", component: AgentShowcase, showInSidebar: true, group: "agent" },
];
