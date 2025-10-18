// File: src/routesConfig.js
// Adds Smart Dialer + renames Dialer → Power Dialer
// + NEW: Enable Notifications (iOS) route

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

// ---- Admin Console ----
import AdminConsole from "./pages/AdminConsole.jsx";

// ---- AI Rebuttal Helper ----
import RebuttalChat from "./pages/RebuttalChat.jsx";

// ---- Call Recorder ----
import CallRecorder from "./pages/CallRecorder.jsx";

// ---- Contacts ----
import ContactsPage from "./pages/ContactsPage.jsx";

// ---- Message Lab ----
import MessageTestPage from "./pages/MessageTestPage.jsx";

// ---- Lead Rescue ----
import LeadRescuePage from "./pages/LeadRescuePage.jsx";

// ---- Dialers ----
import DialerPage from "./pages/DialerPage.jsx";
import SmartDialerPage from "./pages/SmartDialer.jsx"; // ← NEW

// ---- Reviews ----
import ReviewsManager from "./pages/ReviewsManager.jsx";

// ---- NEW: Enable Notifications (iOS) ----
import EnablePushIOS from "./pages/EnablePushIOS.jsx";

export const routes = [
  // Top-level
  { key: "home", path: "/app", label: "Home", component: DashboardHome, index: true, showInSidebar: true, section: "top" },
  { key: "leads", path: "/app/leads", label: "Leads", component: LeadsPage, showInSidebar: true, section: "top" },
  { key: "pipeline", path: "/app/pipeline", label: "Pipeline", component: PipelinePage, showInSidebar: true, section: "top" },
  { key: "messages", path: "/app/messages", label: "Messages", component: MessagesPage, showInSidebar: true, section: "top" },
  { key: "calendar", path: "/app/calendar", label: "Calendar", component: CalendarPage, showInSidebar: true, section: "top" },

  // Productivity & Communication
  { key: "dialer", path: "/app/dialer", label: "Power Dialer", component: DialerPage, showInSidebar: true, section: "productivity" },
  { key: "smart-dialer", path: "/app/smart-dialer", label: "Smart Dialer", component: SmartDialerPage, showInSidebar: true, section: "productivity" }, // ← NEW
  { key: "contacts", path: "/app/contacts", label: "Contacts", component: ContactsPage, showInSidebar: true, section: "productivity" },
  { key: "lead-rescue", path: "/app/lead-rescue", label: "Lead Rescue", component: LeadRescuePage, showInSidebar: true, section: "productivity" },
  { key: "msgSettings", path: "/app/messaging-settings", label: "Messaging Settings", component: MessagingSettings, showInSidebar: true, section: "productivity" },
  { key: "mailing", path: "/app/mailing", label: "Mailing", component: MailingPage, showInSidebar: true, section: "productivity" },
  { key: "rebuttal", path: "/app/rebuttal", label: "AI Rebuttal Helper", component: RebuttalChat, showInSidebar: true, section: "productivity" },
  { key: "call-recorder", path: "/app/call-recorder", label: "Call Recorder", component: CallRecorder, showInSidebar: true, section: "productivity" },

  // Insights & Tools
  { key: "reports", path: "/app/reports", label: "Reports", component: ReportsPage, showInSidebar: true, section: "insights_tools" },
  { key: "tools", path: "/app/tools", label: "Agent Tools", component: ToolsPage, showInSidebar: true, section: "insights_tools" },

  // Agent Site Management
  { key: "agentShowcase", path: "/app/agent/showcase", label: "Edit Agent Site", component: AgentShowcase, showInSidebar: true, section: "agent_site" },
  { key: "reviews", path: "/app/reviews", label: "Reviews", component: ReviewsManager, showInSidebar: true, section: "agent_site" },

  // Teams
  { key: "my-teams", path: "/app/teams", label: "My Teams", component: MyTeams, showInSidebar: true, section: "teams" },
  { key: "team-manage", path: "/app/team/manage/:teamId", label: "Manage Team", component: TeamManagement, showInSidebar: false, section: "hidden" },
  { key: "team-dashboard", path: "/app/team/:teamId/dashboard", label: "Team Dashboard", component: TeamDashboard, showInSidebar: false, section: "hidden" },

  // Bottom (Account & Help)
  // Put Enable Notifications (iOS) ABOVE Settings:
  { key: "enable-ios-push", path: "/app/enable-ios-push", label: "Enable Notifications (iOS)", component: EnablePushIOS, showInSidebar: true, section: "bottom" },
  { key: "settings", path: "/app/settings", label: "Settings", component: SettingsPage, showInSidebar: true, section: "bottom" },
  { key: "support", path: "/app/support", label: "Support", component: SupportPage, showInSidebar: true, section: "bottom" },

  // Admin-only (hidden)
  { key: "admin-console", path: "/app/admin", label: "Admin Console", component: AdminConsole, showInSidebar: false, section: "hidden", adminOnly: true },

  // Private
  { key: "message-lab", path: "/app/message-lab", label: "Message Lab", component: MessageTestPage, showInSidebar: false, section: "hidden" },

  // Legal
  { key: "terms", path: "/legal/terms", label: "Terms of Service", component: TermsPage, showInSidebar: false, section: "hidden" },
  { key: "privacy", path: "/legal/privacy", label: "Privacy Policy", component: PrivacyPage, showInSidebar: false, section: "hidden" },
];
