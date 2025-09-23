// File: src/routesConfig.js
// Adds `section` for sidebar grouping and renames "Tools" -> "Agent Tools" (UI label only)

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

// ---- Admin-only Support Inbox ----
import AdminSupportInbox from "./pages/AdminSupportInbox.jsx";

// ---- AI Rebuttal Helper ----
import RebuttalChat from "./pages/RebuttalChat.jsx";

// ---- Call Recorder ----
import CallRecorder from "./pages/CallRecorder.jsx";

// ---- Contacts (NEW) ----
import ContactsPage from "./pages/ContactsPage.jsx";


// ---- Message Lab (PRIVATE) ----
import MessageTestPage from "./pages/MessageTestPage.jsx"; // <— NEW

// ---- Lead Rescue (NEW) ----
import LeadRescuePage from "./pages/LeadRescuePage.jsx"; // <— NEW

// Sidebar sections:
// "top" → Top-Level (Most Used Daily)
// "productivity" → Productivity & Communication
// "insights_tools" → Insights & Tools
// "agent_site" → Agent Site Management
// "teams" → Teams
// "bottom" → Account & Help (fixed bottom area)
// "hidden" → not shown

export const routes = [
  // Top-level
  { key: "home",     path: "/app",          label: "Home",     component: DashboardHome, index: true, showInSidebar: true, section: "top" },
  { key: "leads",    path: "/app/leads",    label: "Leads",    component: LeadsPage,                 showInSidebar: true, section: "top" },
  { key: "pipeline", path: "/app/pipeline", label: "Pipeline", component: PipelinePage,              showInSidebar: true, section: "top" },
  { key: "messages", path: "/app/messages", label: "Messages", component: MessagesPage,              showInSidebar: true, section: "top" },
  { key: "calendar", path: "/app/calendar", label: "Calendar", component: CalendarPage,              showInSidebar: true, section: "top" },

  // Productivity & Communication
  { key: "contacts",      path: "/app/contacts",           label: "Contacts",           component: ContactsPage,     showInSidebar: true, section: "productivity" }, // NEW
  { key: "lead-rescue",   path: "/app/lead-rescue",        label: "Lead Rescue",        component: LeadRescuePage,   showInSidebar: true, section: "productivity" }, // NEW
  { key: "msgSettings",   path: "/app/messaging-settings", label: "Messaging Settings", component: MessagingSettings, showInSidebar: true, section: "productivity" },
  { key: "mailing",       path: "/app/mailing",            label: "Mailing",            component: MailingPage,      showInSidebar: true, section: "productivity" },
  { key: "rebuttal",      path: "/app/rebuttal",           label: "AI Rebuttal Helper", component: RebuttalChat,     showInSidebar: true, section: "productivity" },
  { key: "call-recorder", path: "/app/call-recorder",      label: "Call Recorder",      component: CallRecorder,     showInSidebar: true, section: "productivity" },

  // Insights & Tools
  { key: "reports", path: "/app/reports", label: "Reports",     component: ReportsPage, showInSidebar: true, section: "insights_tools" },
  { key: "tools",   path: "/app/tools",   label: "Agent Tools", component: ToolsPage,   showInSidebar: true, section: "insights_tools" },

  // Agent Site Management
  { key: "agentShowcase", path: "/app/agent/showcase", label: "Edit Agent Site", component: AgentShowcase, showInSidebar: true, section: "agent_site" },
  // (If you add "View My Agent Site" route, place it here too.)

  // Teams
  { key: "my-teams",       path: "/app/teams",                  label: "My Teams",       component: MyTeams,        showInSidebar: true,  section: "teams" },
  { key: "team-manage",    path: "/app/team/manage/:teamId",    label: "Manage Team",    component: TeamManagement, showInSidebar: false, section: "hidden" },
  { key: "team-dashboard", path: "/app/team/:teamId/dashboard", label: "Team Dashboard", component: TeamDashboard,  showInSidebar: false, section: "hidden" },

  // Bottom (Account & Help)
  { key: "settings", path: "/app/settings", label: "Settings", component: SettingsPage, showInSidebar: true, section: "bottom" },
  { key: "support",  path: "/app/support",  label: "Support",  component: SupportPage,  showInSidebar: true, section: "bottom" },

  // Admin-only (hidden)
  { key: "support-inbox", path: "/app/support-inbox", label: "Support Inbox", component: AdminSupportInbox, showInSidebar: false, section: "hidden" },

  // PRIVATE: Message Lab (hidden)
  { key: "message-lab", path: "/app/message-lab", label: "Message Lab", component: MessageTestPage, showInSidebar: false, section: "hidden" }, // <— NEW

  // Legal (hidden)
  { key: "terms",   path: "/legal/terms",   label: "Terms of Service", component: TermsPage,   showInSidebar: false, section: "hidden" },
  { key: "privacy", path: "/legal/privacy", label: "Privacy Policy",   component: PrivacyPage, showInSidebar: false, section: "hidden" },
];
