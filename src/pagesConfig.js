// File: src/pagesConfig.js

export const ownerEmail = "jacobprieto@gmail.com";

// Flip any page to true to show "Under maintenance" for everyone except ownerEmail.
// Keys should match the page keys you pass to RouteWithMaintenance below.
export const pageToggles = {
  // Top-level
  DashboardHome: false,
  LeadsPage: false,
  PipelinePage: false,
  MessagesPage: false,
  CalendarPage: false,

  // Productivity & Communication
  ContactsPage: false,
  MessagingSettings: false,
  MailingPage: false,
  RebuttalChat: false,
  CallRecorder: false,

  // Insights & Tools
  ReportsPage: false,
  ToolsPage: false,

  // Agent Site
  AgentShowcase: false,

  // Teams
  MyTeams: false,
  TeamManagement: false,
  TeamDashboard: false,

  // Bottom
  SettingsPage: false,
  SupportPage: false,

  // Admin-only
  AdminSupportInbox: false,

  // Legal
  TermsPage: false,
  PrivacyPage: false,
};
