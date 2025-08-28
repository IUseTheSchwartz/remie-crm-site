const PLANS = [
  {
    name: "Solo",
    blurb: "For individual producers ready to ditch spreadsheets.",
    monthly: 59,      // updated
    yearly: 50,       // updated
    features: [
      "Lead inbox & visual pipeline",
      "Manage your leads & book of business",
      "Two-way SMS & email campaigns (starter templates)",
      "Basic dialing (click-to-call)",
      "Final Expense Day-1 cadence (texts + calls)",
      "Client payment reminders (auto tasks/texts)",
      "TCPA/DNC tools & A2P 10DLC assistance",
      "Up to 2,000 contacts",
    ],
    ctaNote: "Best for new agents",
  },
  {
    name: "Team",
    blurb: "For small teams that want shared workflows.",
    monthly: 100,     // updated
    yearly: 89,       // updated
    features: [
      "Everything in Solo",
      "Team inbox, shared calendars & round-robin",
      "Power dialer & call queues",
      "Automated no-show campaigns (reschedule link)",
      "Carrier quote & application hub (beta)",
      "Personalized landing pages for IUL, MP & FEX (add-on)",
      "Leaderboards & role-based permissions",
      "Up to 5,000 contacts",
    ],
    seat: { monthly: 19, yearly: 15 },
    ctaNote: "Most popular",
    highlighted: true,
  },
  {
    name: "Agency",
    blurb: "For agencies scaling producers and overrides.",
    monthly: 500,     // updated
    yearly: 400,      // updated
    features: [
      "Everything in Team",
      "Multi-team workspaces",
      "Commission & override tracking",
      "Chargeback Guard (renewal/lapse alerts)",
      "Concierge migration + done-for-you onboarding",
      "Bootcamp training library & weekly office hours",
      "Direct-mail campaign exports & print-ready lists",
      "Full audit trails & one-click data export",
      "20,000+ contacts (elastic scaling available)",
    ],
    seat: { monthly: 29, yearly: 24 },
    ctaNote: "Scale-ready",
  },
];
