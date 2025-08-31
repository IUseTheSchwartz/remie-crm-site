// File: src/routesConfig.js
import DashboardHome from "./pages/DashboardHome.jsx";
import LeadsPage from "./pages/LeadsPage.jsx";
import ReportsPage from "./pages/ReportsPage.jsx";
import CalendarPage from "./pages/CalendarPage.jsx";
import SettingsPage from "./pages/SettingsPage.jsx";
import AgentShowcase from "./pages/AgentShowcase.jsx";
// If/when you add ToolsPage, just import and add an item here.

export const routes = [
  // Main section
  { key: "home",     path: "/app",          label: "Home",     element: <DashboardHome />, index: true,  showInSidebar: true,  group: "main" },
  { key: "leads",    path: "/app/leads",    label: "Leads",    element: <LeadsPage />,                    showInSidebar: true,  group: "main" },
  { key: "reports",  path: "/app/reports",  label: "Reports",  element: <ReportsPage />,                  showInSidebar: true,  group: "main" },
  { key: "calendar", path: "/app/calendar", label: "Calendar", element: <CalendarPage />,                 showInSidebar: true,  group: "main" },
  { key: "settings", path: "/app/settings", label: "Settings", element: <SettingsPage />,                 showInSidebar: true,  group: "main" },

  // Agent section (appears under the divider)
  { key: "agentShowcase", path: "/app/agent/showcase", label: "Edit Agent Site", element: <AgentShowcase />, showInSidebar: true, group: "agent" },
];
