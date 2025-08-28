// File: src/App.jsx
import { useState } from "react";
import { Routes, Route, Link, Navigate, useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import {
  Check,
  Shield,
  Star,
  Zap,
  Phone,
  CreditCard,
  LogOut,
} from "lucide-react";

import ProtectedRoute from "./components/ProtectedRoute.jsx";
import { AuthProvider, useAuth } from "./auth.jsx";
import LoginPage from "./pages/LoginPage.jsx";
import SignupPage from "./pages/SignupPage.jsx";

// NEW: imports for dashboard + extra pages
import NumberCard from "./components/NumberCard.jsx";
import { dashboardSnapshot } from "./lib/stats.js";
import ReportsPage from "./pages/ReportsPage.jsx";
import LeadsPage from "./pages/LeadsPage.jsx";

// -------- Shared brand --------
const BRAND = {
  name: "Remie CRM",
  primary: "from-indigo-500 via-purple-500 to-fuchsia-500",
  accentRing: "ring-indigo-400/50",
};

// -------- Pricing plans --------
const PLANS = [
  {
    name: "Mail List",
    blurb: "Auto-send birthday & holiday mailings to stay top-of-mind.",
    monthly: 100,
    yearly: 80,
    buyUrl: {
      monthly: "https://buy.stripe.com/test_8x24gBghhaXefke23T5c405",
      annual: "https://buy.stripe.com/test_28EaEZ4yz0iAfkedMB5c404",
    },
    features: [
      "Birthday letters auto-sent",
      "Holiday greetings auto-sent",
      "Upload CSV and go",
      "Custom templates",
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
      "Leads inbox & pipeline",
      "Two-way texting/email",
      "Click-to-call dialer",
      "No-show rescue campaigns",
      "Bootcamp + ongoing trainings",
    ],
    ctaNote: "Best for solo agents",
  },
  {
    name: "Pro",
    blurb: "All Basic features, plus unlimited team members for your agency.",
    monthly: 1500,
    yearly: 1200,
    buyUrl: {
      monthly: "https://buy.stripe.com/test_00w28tc11d5m4FAaAp5c400",
      annual: "https://buy.stripe.com/test_14AcN7d55fdu6NIfUJ5c401",
    },
    features: [
      "Everything in Basic",
      "Unlimited team member access",
      "Concierge migration",
      "Shared inbox & calendars",
    ],
    ctaNote: "For agencies",
    highlighted: true,
  },
];

// ---------- Landing Page ----------
function LandingPage() {
  const [annual, setAnnual] = useState(true);
  const price = (plan) => (annual ? plan.yearly : plan.monthly);

  return (
    <div className="min-h-screen bg-neutral-950 text-white">
      {/* Header */}
      <header className="relative z-10 border-b border-white/10 backdrop-blur">
        <nav className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <div
              className={`grid h-9 w-9 place-items-center rounded-2xl bg-gradient-to-br ${BRAND.primary}`}
            >
              <Zap className="h-5 w-5" />
            </div>
            <span className="font-semibold">{BRAND.name}</span>
          </div>
          <div className="flex items-center gap-3">
            <Link to="/login" className="text-sm opacity-80 hover:opacity-100">
              Log in
            </Link>
            <Link
              to="/signup"
              className={`rounded-xl bg-gradient-to-r ${BRAND.primary} px-4 py-2 text-sm`}
            >
              Start free trial
            </Link>
          </div>
        </nav>
      </header>

      {/* Hero */}
      <section className="mx-auto max-w-3xl text-center py-16 px-6">
        <motion.h1
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-4xl font-semibold"
        >
          Close more policies. Not tabs.
        </motion.h1>
        <p className="mt-4 text-lg text-white/70">
          Choose the plan that fits your workflow.
        </p>
      </section>

      {/* Pricing */}
      <section className="mx-auto max-w-7xl px-6 py-14">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-semibold">Pricing</h2>
          <div className="mt-6 inline-flex rounded-full border border-white/15 p-1">
            <button
              onClick={() => setAnnual(false)}
              className={`px-3 py-1 ${!annual ? "bg-white text-black" : ""}`}
            >
              Monthly
            </button>
            <button
              onClick={() => setAnnual(true)}
              className={`px-3 py-1 ${annual ? "bg-white text-black" : ""}`}
            >
              Annual
            </button>
          </div>
        </div>
        <div className="mt-10 grid gap-6 md:grid-cols-3">
          {PLANS.map((plan) => (
            <div
              key={plan.name}
              className="rounded-3xl border border-white/10 bg-white/[0.04] p-6"
            >
              <h3 className="text-xl font-semibold">{plan.name}</h3>
              <p className="text-sm text-white/70">{plan.blurb}</p>
              <div className="mt-5 flex items-baseline gap-2">
                <span className="text-4xl font-bold">${price(plan)}</span>
                <span className="text-white/60">/mo</span>
              </div>
              <ul className="mt-6 space-y-2 text-sm">
                {plan.features.map((f) => (
                  <li key={f} className="flex gap-2">
                    <Check className="h-3.5 w-3.5" /> {f}
                  </li>
                ))}
              </ul>
              <a
                href={annual ? plan.buyUrl.annual : plan.buyUrl.monthly}
                target="_blank"
                rel="noreferrer"
                className="mt-6 block rounded-2xl bg-white/10 px-4 py-3 text-center"
              >
                Buy {plan.name}
              </a>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

// ---------- Dashboard Layout ----------
function AppLayout() {
  const { user, logout } = useAuth();
  const nav = useNavigate();

  return (
    <div className="min-h-screen bg-neutral-950 text-white grid md:grid-cols-[240px_1fr]">
      <aside className="hidden md:block border-r border-white/10">
        <div className="p-4 flex items-center gap-3 border-b border-white/10">
          <Zap className="h-5 w-5" />
          <div className="font-semibold">{BRAND.name}</div>
        </div>
        <nav className="p-3 space-y-1 text-sm">
          <DashLink to="/app">Home</DashLink>
          <DashLink to="/app/leads">Leads</DashLink>
          <DashLink to="/app/reports">Reports</DashLink>
          <DashLink to="/app/settings">Settings</DashLink>
        </nav>
      </aside>

      <main>
        <div className="flex justify-between border-b border-white/10 px-4 py-3">
          <div>Welcome {user?.email}</div>
          <button
            onClick={async () => {
              await logout();
              nav("/");
            }}
            className="rounded-lg border border-white/15 px-3 py-1.5 text-sm"
          >
            <LogOut className="h-4 w-4" /> Log out
          </button>
        </div>
        <div className="p-4">
          <Routes>
            <Route index element={<DashboardHome />} />
            <Route path="leads" element={<LeadsPage />} />
            <Route path="reports" element={<ReportsPage />} />
            <Route path="settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/app" replace />} />
          </Routes>
        </div>
      </main>
    </div>
  );
}

function DashLink({ to, children }) {
  return (
    <Link
      to={to}
      className="block rounded-lg px-3 py-2 text-white/80 hover:bg-white/5"
    >
      {children}
    </Link>
  );
}

// ---------- DashboardHome with KPIs ----------
function DashboardHome() {
  const snap = dashboardSnapshot();

  const kpi = [
    { label: "Closed (today)", value: snap.today.closed },
    { label: "Clients (today)", value: snap.today.clients },
    { label: "Leads (today)", value: snap.today.leads },
    { label: "Appointments (today)", value: snap.today.appointments },
  ];

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-4">
        {kpi.map((x) => (
          <NumberCard key={x.label} label={x.label} value={x.value} />
        ))}
      </div>
    </div>
  );
}

function Settings() {
  return <div>Settings coming soon…</div>;
}

// ---------- App root ----------
export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/signup" element={<SignupPage />} />
        <Route element={<ProtectedRoute />}>
          <Route path="/app/*" element={<AppLayout />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  );
}
