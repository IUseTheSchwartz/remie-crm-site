// File: src/App.jsx
import { useState } from "react";
import { Routes, Route, Link, Navigate, useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { Check, Zap, LogOut, Phone, Shield, Star, CreditCard } from "lucide-react";

import ProtectedRoute from "./components/ProtectedRoute.jsx";
import { AuthProvider, useAuth } from "./auth.jsx";
import LoginPage from "./pages/LoginPage.jsx";
import SignupPage from "./pages/SignupPage.jsx";

// Pages
import LeadsPage from "./pages/LeadsPage.jsx";
import ReportsPage from "./pages/ReportsPage.jsx";
import SettingsPage from "./pages/SettingsPage.jsx";

// ✅ Agent Showcase pages (import ONCE)
import AgentShowcase from "./pages/AgentShowcase.jsx"; // private wizard
import AgentPublic from "./pages/AgentPublic.jsx";     // public profile

// KPI helpers
import NumberCard from "./components/NumberCard.jsx";
import { dashboardSnapshot } from "./lib/stats.js";

// Subscription gate
import SubscriptionGate from "./components/SubscriptionGate.jsx";

// Brand / theme
const BRAND = {
  name: "Remie CRM",
  primary: "from-indigo-500 via-purple-500 to-fuchsia-500",
  accentRing: "ring-indigo-400/50",
};

// Pricing plans
const PLANS = [
  {
    name: "Mail List",
    blurb: "Hands-off client touchpoints with auto birthday & holiday mailers.",
    monthly: 100,
    yearly: 80,
    buyUrl: {
      monthly: "https://buy.stripe.com/test_8x24gBghhaXefke23T5c405",
      annual: "https://buy.stripe.com/test_28EaEZ4yz0iAfkedMB5c404",
    },
    features: [
      "Automatic birthday letters for each contact",
      "Automatic holiday greetings",
      "Upload CSV and set-it-and-forget-it",
      "Custom message templates",
      "Activity log",
    ],
    ctaNote: "Stay top-of-mind",
  },
  {
    name: "Basic",
    blurb: "All Pro features, just for a single user.",
    monthly: 350,
    yearly: 280,
    buyUrl: {
      monthly: "https://buy.stripe.com/test_8x28wR9ST7L2dc6gYN5c403",
      annual: "https://buy.stripe.com/test_00w5kF5CD8P67RM8sh5c402",
    },
    features: [
      "Lead inbox & drag-and-drop pipeline",
      "Two-way texting & email",
      "Click-to-call dialing",
      "Simple automations",
      "Tasks & reminders",
      "Notes & files on contacts",
      "Shared inbox & calendars",
      "Power dialer & call queues",
      "No-show rescue campaigns",
      "Quote & application hub (beta)",
      "Bootcamp + ongoing trainings",
      "Concierge migration",
    ],
    ctaNote: "Best for solo agents",
  },
  {
    name: "Pro",
    blurb: "All Basic features for your whole agency — unlimited team access.",
    monthly: 1500,
    yearly: 1200,
    buyUrl: {
      monthly: "https://buy.stripe.com/test_00w28tc11d5m4FAaAp5c400",
      annual: "https://buy.stripe.com/test_14AcN7d55fdu6NIfUJ5c401",
    },
    features: ["Everything in Basic", "Unlimited team access", "Concierge migration", "Shared inbox & calendars"],
    ctaNote: "For growing agencies",
    highlighted: true,
  },
];

// ---------- Landing Page ----------
function LandingPage() {
  const [annual, setAnnual] = useState(true);
  const price = (plan) => (annual ? plan.yearly : plan.monthly);

  return (
    <div className="min-h-screen bg-neutral-950 text-white">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-56 left-1/2 h-[36rem] w-[36rem] -translate-x-1/2 rounded-full bg-gradient-to-br from-indigo-600/20 via-fuchsia-500/10 to-rose-500/10 blur-3xl" />
      </div>

      <header className="relative z-10 border-b border-white/10 backdrop-blur">
        <nav className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <div className={`grid h-9 w-9 place-items-center rounded-2xl bg-gradient-to-br ${BRAND.primary} ring-1 ring-white/10`}>
              <Zap className="h-5 w-5" />
            </div>
            <span className="font-semibold tracking-tight">{BRAND.name}</span>
          </div>
          <div className="flex items-center gap-3">
            <Link to="/login" className="text-sm opacity-80 hover:opacity-100">Log in</Link>
            <Link to="/signup" className={`hidden rounded-xl bg-gradient-to-r ${BRAND.primary} px-4 py-2 text-sm font-medium ring-1 ring-white/10 md:block`}>
              Start 14-day free trial
            </Link>
          </div>
        </nav>
      </header>

      <section className="relative z-10 mx-auto max-w-7xl px-6 pb-10 pt-16 sm:pt-20">
        <div className="mx-auto max-w-3xl text-center">
          <motion.h1 initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}
            className="text-4xl font-semibold leading-tight sm:text-5xl">
            Close more policies. Not tabs.
          </motion.h1>
          <p className="mt-4 text-lg text-white/70">
            Choose the plan that fits your workflow—stay in touch automatically,
            run a clean solo pipeline, or plug your whole team into one system.
          </p>
          <div className="mt-6 flex items-center justify-center gap-6 text-xs text-white/60">
            <span className="inline-flex items-center gap-1"><Star className="h-4 w-4" /> Concierge migration (Pro)</span>
            <span className="inline-flex items-center gap-1"><Phone className="h-4 w-4" /> Click-to-call & power dialer</span>
            <span className="inline-flex items-center gap-1"><Shield className="h-4 w-4" /> Bootcamp for new features</span>
          </div>
        </div>
      </section>

      <section id="pricing" className="relative z-10 mx-auto max-w-7xl px-6 py-14">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">Simple, transparent pricing</h2>
          <p className="mt-2 text-white/70">Switch between monthly and annual billing. Annual saves around 20%.</p>
          <div className="mt-6 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 p-1 text-sm">
            <button onClick={() => setAnnual(false)} className={`rounded-full px-3 py-1 ${!annual ? "bg-white text-black" : "text-white/80"}`}>Monthly</button>
            <button onClick={() => setAnnual(true)} className={`rounded-full px-3 py-1 ${annual ? "bg-white text-black" : "text-white/80"}`}>Annual</button>
          </div>
        </div>

        <div className="mt-10 grid gap-6 md:grid-cols-3">
          {PLANS.map((plan) => (
            <div key={plan.name}
              className={`relative rounded-3xl border ${plan.highlighted ? "border-white/30 bg-white/[0.06]" : "border-white/10 bg-white/[0.04]"} p-6 ring-1 ${plan.highlighted ? BRAND.accentRing : "ring-white/5"}`}>
              {plan.ctaNote && (
                <div className="absolute -top-3 left-6 rounded-full border border-white/15 bg-white/10 px-3 py-1 text-xs font-medium backdrop-blur">
                  {plan.ctaNote}
                </div>
              )}
              <h3 className="text-xl font-semibold">{plan.name}</h3>
              <p className="mt-1 text-sm text-white/70">{plan.blurb}</p>
              <div className="mt-5 flex items-baseline gap-2">
                <span className="text-4xl font-bold">${price(plan)}</span>
                <span className="text-white/60">/mo {annual && <span className="text-white/40">(annual)</span>}</span>
              </div>
              <ul className="mt-6 space-y-2 text-sm">
                {plan.features.map((f) => (
                  <li key={f} className="flex items-start gap-2">
                    <span className="mt-0.5 rounded-full bg-white/10 p-1 ring-1 ring-white/10"><Check className="h-3.5 w-3.5" /></span>
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
              <a
                href={annual ? plan.buyUrl?.annual : plan.buyUrl?.monthly}
                target="_blank" rel="noreferrer"
                className={`mt-6 grid w-full place-items-center rounded-2xl border border-white/15 px-4 py-3 font-medium hover:bg-white/10 ${plan.highlighted ? `bg-gradient-to-r ${BRAND.primary}` : "bg-white/5"}`}>
                <CreditCard className="mr-2 h-5 w-5" /> Buy {plan.name}
              </a>
            </div>
          ))}
        </div>

        <p className="mt-6 text-center text-xs text-white/50">Prices in USD. Annual pricing shows per-month equivalent, billed annually.</p>
      </section>

      <footer className="relative z-10 border-t border-white/10 bg-black/40">
        <div className="mx-auto max-w-7xl px-6 py-6 text-center text-xs text-white/60">
          © {new Date().getFullYear()} {BRAND.name}. All rights reserved.
        </div>
      </footer>
    </div>
  );
}

// ---------- App Layout (sidebar + routes) ----------
function AppLayout() {
  const { user, logout } = useAuth();
  const nav = useNavigate();

  return (
    <div className="min-h-screen bg-neutral-950 text-white grid md:grid-cols-[240px_1fr]">
      <aside className="hidden md:block border-r border-white/10 bg-black/30">
        <div className="p-4 flex items-center gap-3 border-b border-white/10">
          <div className={`grid h-9 w-9 place-items-center rounded-2xl bg-gradient-to-br ${BRAND.primary} ring-1 ring-white/10`}>
            <Zap className="h-5 w-5" />
          </div>
          <div className="font-semibold">{BRAND.name}</div>
        </div>
        <nav className="p-3 space-y-1 text-sm">
          <DashLink to="/app">Home</DashLink>
          <DashLink to="/app/leads">Leads</DashLink>
          <DashLink to="/app/reports">Reports</DashLink>
          <DashLink to="/app/settings">Settings</DashLink>
          {/* New: Agent Showcase wizard link (optional add to sidebar) */}
          <DashLink to="/app/agent-showcase">Agent Showcase</DashLink>
        </nav>
      </aside>

      <main>
        <div className="flex items-center justify-between border-b border-white/10 bg-black/30 px-4 py-3">
          <div className="font-medium">Welcome{user?.email ? `, ${user.email}` : ""}</div>
          <button
            onClick={async () => { await logout(); nav("/"); }}
            className="inline-flex items-center gap-2 rounded-lg border border-white/15 px-3 py-1.5 text-sm hover:bg-white/5"
          >
            <LogOut className="h-4 w-4" /> Log out
          </button>
        </div>

        <div className="p-4">
          <Routes>
            {/* Keep Settings always visible (no subscription gate) */}
            <Route path="settings" element={<SettingsPage />} />

            {/* Subscription-gated pages */}
            <Route
              index
              element={
                <SubscriptionGate>
                  <DashboardHome />
                </SubscriptionGate>
              }
            />
            <Route
              path="leads"
              element={
                <SubscriptionGate>
                  <LeadsPage />
                </SubscriptionGate>
              }
            />
            <Route
              path="reports"
              element={
                <SubscriptionGate>
                  <ReportsPage />
                </SubscriptionGate>
              }
            />
            {/* New: Agent Showcase wizard (private) */}
            <Route
              path="agent-showcase"
              element={
                <SubscriptionGate>
                  <AgentShowcase />
                </SubscriptionGate>
              }
            />

            <Route path="*" element={<Navigate to="/app" replace />} />
          </Routes>
        </div>
      </main>
    </div>
  );
}

function DashLink({ to, children }) {
  return (
    <Link to={to} className="block rounded-lg px-3 py-2 text-white/80 hover:bg-white/5 hover:text-white">
      {children}
    </Link>
  );
}

function Card({ title, children }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 ring-1 ring-white/5">
      <div className="mb-2 text-sm font-semibold">{title}</div>
      <div className="text-sm text-white/80">{children}</div>
    </div>
  );
}

// ---------- Dashboard ----------
function DashboardHome() {
  const snap = dashboardSnapshot();
  const money = (n) =>
    Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n || 0);

  const kpi = [
    { label: "Closed (today)", value: snap.today.closed, sub: `This month: ${snap.thisMonth.closed}` },
    { label: "Clients (today)", value: snap.today.clients, sub: `This month: ${snap.thisMonth.clients}` },
    { label: "Leads (today)", value: snap.today.leads, sub: `This week: ${snap.thisWeek.leads}` },
    { label: "Appointments (today)", value: snap.today.appointments, sub: `This week: ${snap.thisWeek.appointments}` },
  ];

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-4">
        {kpi.map((x) => (
          <NumberCard key={x.label} label={x.label} value={x.value} sublabel={x.sub} />
        ))}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="This Week">
          <div className="grid grid-cols-5 gap-3 text-sm">
            <NumberCard label="Closed" value={snap.thisWeek.closed} />
            <NumberCard label="Clients" value={snap.thisWeek.clients} />
            <NumberCard label="Leads" value={snap.thisWeek.leads} />
            <NumberCard label="Appts" value={snap.thisWeek.appointments} />
            <NumberCard label="Premium" value={money(snap.thisWeek.premium)} />
          </div>
        </Card>
        <Card title="This Month">
          <div className="grid grid-cols-5 gap-3 text-sm">
            <NumberCard label="Closed" value={snap.thisMonth.closed} />
            <NumberCard label="Clients" value={snap.thisMonth.clients} />
            <NumberCard label="Leads" value={snap.thisMonth.leads} />
            <NumberCard label="Appts" value={snap.thisMonth.appointments} />
            <NumberCard label="Premium" value={money(snap.thisMonth.premium)} />
          </div>
        </Card>
      </div>
    </div>
  );
}

// ---------- App root ----------
export default function App() {
  return (
    <AuthProvider>
      <Routes>
        {/* Public pages */}
        <Route path="/" element={<LandingPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/signup" element={<SignupPage />} />
        {/* New: public agent profile */}
        <Route path="/agent/:slug" element={<AgentPublic />} />

        {/* Private app */}
        <Route element={<ProtectedRoute />}>
          <Route path="/app/*" element={<AppLayout />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  );
}
