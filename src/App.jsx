// File: src/App.jsx
import { useState, useEffect } from "react";
import { Routes, Route, Link, Navigate, useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import {
  Check,
  Zap, // kept as-is even though not used
  LogOut,
  Shield,
  Star,
  CreditCard,
  ExternalLink,
  StickyNote,
  CheckCircle2,
} from "lucide-react";

import ProtectedRoute from "./components/ProtectedRoute.jsx";
import { AuthProvider, useAuth } from "./auth.jsx";
import LoginPage from "./pages/LoginPage.jsx";
import SignupPage from "./pages/LoginPage.jsx"; // keeping exactly what you had
import AgentPublic from "./pages/AgentPublic.jsx";
import AcceptInvite from "./pages/AcceptInvite.jsx"; // ✅ NEW

// Supabase
import { supabase } from "./lib/supabaseClient.js";

// Routes config (component refs, no JSX inside)
import { routes } from "./routesConfig.js";

// ✅ Legal pages
import TermsPage from "./pages/legal/Terms.jsx";
import PrivacyPage from "./pages/legal/Privacy.jsx";

// ✅ Logo (tight-cropped PNG)
import Logo from "./assets/logo-tight.png";

// Brand / theme
const BRAND = {
  name: "Remie CRM",
  primary: "from-indigo-500 via-purple-500 to-fuchsia-500",
  accentRing: "ring-indigo-400/50",
};

// ---------- Pricing cards data ----------
const PLANS = [
  {
    name: "Remie CRM",
    blurb: "All-in-one CRM for agents — pipeline, automations, and more.",
    monthly: 280,
    yearly: 250,
    buyUrl: {
      monthly: "https://buy.stripe.com/28E4gB8OScYeffg2qg8Ra07",
      annual: "https://buy.stripe.com/5kQ28tfdg2jA0km7KA8Ra0a",
    },
    features: [
      "automated message system",
      "appointment tracker",
      "personalized agent website",
      "Notes & files on contacts",
      "easy to use pipeline",
      "No-show rescue campaigns",
      "Agent tools",
      "Automated Client Mail(coming soon)",
      "pay per text 1cent",
      "Team integration (create your own team)",
      "Personal Stat Tracker",
      "Team Stat Tracker+leaderboard",
    ],
    ctaNote: "Best for agents & small teams",
    highlighted: true,
  },
];

/* --------------------------- Mini Pipeline Demo ---------------------------- */

const DEMO_STAGES = [
  { id: "no_pickup", label: "No Pickup" },
  { id: "answered", label: "Answered" },
  { id: "quoted", label: "Quoted" },
  { id: "app_started", label: "App Started" },
  { id: "app_pending", label: "App Pending" },
  { id: "app_submitted", label: "App Submitted" },
];

const DEMO_ROWS = [
  ["no_pickup", "answered", "quoted"],
  ["app_started", "app_pending", "app_submitted"],
];

const DEMO_STYLE = {
  no_pickup: "bg-white/10 text-white/80",
  answered: "bg-sky-500/15 text-sky-300",
  quoted: "bg-amber-500/15 text-amber-300",
  app_started: "bg-indigo-500/15 text-indigo-300",
  app_pending: "bg-fuchsia-500/15 text-fuchsia-300",
  app_submitted: "bg-emerald-500/15 text-emerald-300",
};

function PipelineDemo() {
  const [cards, setCards] = useState([
    { id: "d1", name: "Alex M.", stage: "no_pickup", notes: [] },
    { id: "d2", name: "Jordan M.", stage: "answered", notes: [] },
    { id: "d3", name: "Taylor R.", stage: "quoted", notes: [] },
    { id: "d4", name: "Sam K.", stage: "app_started", notes: [] },
    { id: "d5", name: "Jamie L.", stage: "app_pending", notes: [] },
    { id: "d6", name: "Chris D.", stage: "app_submitted", notes: [] },
  ]);
  const [activeNote, setActiveNote] = useState({});

  const move = (id, dir = 1) => {
    setCards((prev) =>
      prev.map((c) => {
        if (c.id !== id) return c;
        const order = DEMO_STAGES.map((s) => s.id);
        const idx = order.indexOf(c.stage);
        const nextIdx = Math.max(0, Math.min(order.length - 1, idx + dir));
        return { ...c, stage: order[nextIdx] };
      })
    );
  };

  const setStage = (id, stage) => {
    setCards((prev) => prev.map((c) => (c.id === id ? { ...c, stage } : c)));
  };

  const addNote = (id) => {
    const text = (activeNote[id] || "").trim();
    if (!text) return;
    setCards((prev) =>
      prev.map((c) =>
        c.id === id
          ? {
              ...c,
              notes: [
                { body: text, ts: new Date().toISOString() },
                ...c.notes,
              ],
            }
          : c
      )
    );
    setActiveNote((n) => ({ ...n, [id]: "" }));
  };

  const StageBadge = ({ stage }) => (
    <span
      className={`rounded-full px-2 py-0.5 text-xs ${
        DEMO_STYLE[stage] || "bg-white/10 text-white/80"
      }`}
    >
      {DEMO_STAGES.find((s) => s.id === stage)?.label || "No Pickup"}
    </span>
  );

  return (
    <div className="rounded-3xl border border-white/10 bg-white/[0.04] p-4 ring-1 ring-white/5">
      <div className="mb-3 flex items-center justify-between">
        <div className="text-sm font-medium">Pipeline Demo (no signup)</div>
        <div className="text-xs text-white/60">
          Try changing stages & adding notes
        </div>
      </div>

      <div className="grid gap-4">
        {DEMO_ROWS.map((row, i) => (
          <div key={i} className="grid gap-4 md:grid-cols-3">
            {row.map((stageId) => (
              <div
                key={stageId}
                className="rounded-2xl border border-white/10 bg-white/[0.03] p-2"
              >
                <div className="flex items-center justify-between px-2 pb-2">
                  <div className="text-sm font-medium">
                    {DEMO_STAGES.find((s) => s.id === stageId)?.label}
                  </div>
                </div>
                <div className="space-y-2">
                  {cards
                    .filter((c) => c.stage === stageId)
                    .map((c) => (
                      <motion.div
                        key={c.id}
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="rounded-xl border border-white/10 bg-black/40 p-3"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="font-medium truncate">{c.name}</div>
                          <StageBadge stage={c.stage} />
                        </div>

                        <div className="mt-2 flex flex-wrap gap-2">
                          {/* Stage picker */}
                          <select
                            value={c.stage}
                            onChange={(e) => setStage(c.id, e.target.value)}
                            className="rounded-md border border-white/10 bg-white/5 px-2 py-1 text-xs"
                          >
                            {DEMO_STAGES.map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.label}
                              </option>
                            ))}
                          </select>

                          <button
                            onClick={() => move(c.id, +1)}
                            className="inline-flex items-center gap-1 rounded-md border border-white/15 px-2 py-1 text-xs hover:bg-white/10"
                            title="Move to next stage"
                          >
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            Advance
                          </button>
                        </div>

                        {/* Notes */}
                        <div className="mt-3">
                          <div className="text-xs text-white/60 mb-1">
                            Add a note
                          </div>
                          <div className="flex gap-2">
                            <input
                              value={activeNote[c.id] || ""}
                              onChange={(e) =>
                                setActiveNote((n) => ({
                                  ...n,
                                  [c.id]: e.target.value,
                                }))
                              }
                              placeholder="e.g., Sent quote for $45/mo"
                              className="w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1 text-xs outline-none focus:ring-2 focus:ring-indigo-500/40"
                            />
                            <button
                              onClick={() => addNote(c.id)}
                              className="inline-flex items-center gap-1 rounded-md border border-white/15 px-2 py-1 text-xs hover:bg-white/10"
                            >
                              <StickyNote className="h-3.5 w-3.5" />
                              Add
                            </button>
                          </div>

                          <div className="mt-2 space-y-1">
                            {c.notes.length === 0 ? (
                              <div className="text-xs text-white/40">
                                No notes yet.
                              </div>
                            ) : (
                              c.notes.map((n, i) => (
                                <div
                                  key={i}
                                  className="rounded-md border border-white/10 bg-black/30 p-2"
                                >
                                  <div className="text-[11px] text-white/50 mb-1">
                                    {new Date(n.ts).toLocaleString()}
                                  </div>
                                  <div className="text-xs">{n.body}</div>
                                </div>
                              ))
                            )}
                          </div>
                        </div>
                      </motion.div>
                    ))}

                  {/* Empty state */}
                  {cards.filter((c) => c.stage === stageId).length === 0 && (
                    <div className="rounded-xl border border-dashed border-white/10 p-4 text-center text-xs text-white/50">
                      No cards in this stage
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------- Main Landing ------------------------------ */

// ---------- Landing Page ----------
function LandingPage() {
  const [annual, setAnnual] = useState(true);

  const displayPrice = (plan) =>
    annual && plan.yearly != null ? plan.yearly : plan.monthly;

  const buyHref = (plan) =>
    annual && plan.buyUrl?.annual ? plan.buyUrl.annual : plan.buyUrl?.monthly;

  return (
    <div className="min-h-screen bg-neutral-950 text-white">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-56 left-1/2 h-[36rem] w-[36rem] -translate-x-1/2 rounded-full bg-gradient-to-br from-indigo-600/20 via-fuchsia-500/10 to-rose-500/10 blur-3xl" />
      </div>

      <header className="relative z-10 border-b border-white/10 backdrop-blur">
        <nav className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <div className="flex items-centered gap-3">
            <div className="grid h-9 w-9 place-items-center">
              <img src={Logo} alt="Logo" className="h-9 w-9 object-contain" />
            </div>
            <span className="font-semibold tracking-tight">{BRAND.name}</span>
          </div>
          <div className="flex items-center gap-3">
            <a href="#contact" className="text-sm opacity-80 hover:opacity-100">
              Contact
            </a>
            <Link
              to="/login"
              className="text-sm opacity-80 hover:opacity-100"
            >
              Log in
            </Link>
            <Link
              to="/signup"
              className={`hidden rounded-xl bg-gradient-to-r ${BRAND.primary} px-4 py-2 text-sm font-medium ring-1 ring-white/10 md:block`}
            >
              Start 14-day free trial
            </Link>
          </div>
        </nav>
      </header>

      <section className="relative z-10 mx-auto max-w-7xl px-6 pb-10 pt-16 sm:pt-20">
        <div className="mx-auto max-w-3xl text-center">
          <motion.h1
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="text-4xl font-semibold leading-tight sm:text-5xl"
          >
            Close more policies. Not tabs.
          </motion.h1>
          <p className="mt-4 text-lg text-white/70">
            Manage your pipeline, automate follow-ups, and keep everything in
            one place.
          </p>
          <div className="mt-6 flex items-center justify-center gap-6 text-xs text-white/60">
            <span className="inline-flex items-center gap-1">
              <Star className="h-4 w-4" /> Concierge migration (Remie CRM)
            </span>
            <span className="inline-flex items-center gap-1">
              <Shield className="h-4 w-4" /> Bootcamp for new features
            </span>
          </div>
        </div>
      </section>

      {/* Pricing + Demo */}
      <section
        id="pricing"
        className="relative z-10 mx-auto max-w-7xl px-6 py-14"
      >
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            Simple, transparent pricing
          </h2>
          <p className="mt-2 text-white/70">
            Switch between monthly and annual billing. Annual saves around 20%
            where available.
          </p>
          <div className="mt-6 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 p-1 text-sm">
            <button
              onClick={() => setAnnual(false)}
              className={`rounded-full px-3 py-1 ${
                !annual ? "bg-white text-black" : "text-white/80"
              }`}
            >
              Monthly
            </button>
            <button
              onClick={() => setAnnual(true)}
              className={`rounded-full px-3 py-1 ${
                annual ? "bg-white text-black" : "text-white/80"
              }`}
            >
              Annual
            </button>
          </div>
        </div>

        <div className="mt-10 grid gap-6 md:grid-cols-2 items-start">
          {PLANS.map((plan) => {
            const isAnnualShown = annual && plan.yearly != null;
            const price = displayPrice(plan);
            const href = buyHref(plan);

            return (
              <div
                key={plan.name}
                className={`relative rounded-3xl border ${
                  plan.highlighted
                    ? "border-white/30 bg-white/[0.06]"
                    : "border-white/10 bg-white/[0.04]"
                } p-6 ring-1 ${
                  plan.highlighted ? BRAND.accentRing : "ring-white/5"
                } transition hover:border-white/30 hover:bg-white/[0.08] hover:ring-indigo-400/50`}
              >
                {plan.ctaNote && (
                  <div className="absolute -top-3 left-6 rounded-full border border-white/15 bg-white/10 px-3 py-1 text-xs font-medium backdrop-blur">
                    {plan.ctaNote}
                  </div>
                )}
                <h3 className="text-xl font-semibold">{plan.name}</h3>
                <p className="mt-1 text-sm text-white/70">{plan.blurb}</p>
                <div className="mt-5 flex items-baseline gap-2">
                  <span className="text-4xl font-bold">${price}</span>
                  <span className="text-white/60">
                    /mo{" "}
                    {isAnnualShown && (
                      <span className="text-white/40">(annual)</span>
                    )}
                  </span>
                </div>
                <ul className="mt-6 space-y-2 text-sm">
                  {plan.features.map((f) => (
                    <li key={f} className="flex items-start gap-2">
                      <span className="mt-0.5 rounded-full bg-white/10 p-1 ring-1 ring-white/10">
                        <Check className="h-3.5 w-3.5" />
                      </span>
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
                <a
                  href={href}
                  target="_blank"
                  rel="noreferrer"
                  className={`mt-6 grid w-full place-items-center rounded-2xl border border-white/15 px-4 py-3 font-medium transition
                    ${
                      plan.highlighted
                        ? `bg-gradient-to-r ${BRAND.primary}`
                        : "bg-white/5"
                    }
                    hover:bg-gradient-to-r ${BRAND.primary} hover:text-white`}
                >
                  <CreditCard className="mr-2 h-5 w-5" /> Buy {plan.name}
                </a>
              </div>
            );
          })}

          <PipelineDemo />
        </div>

        <p className="mt-6 text-center text-xs text-white/50">
          Prices in USD. Annual pricing shows per-month equivalent, billed
          annually (where available).
        </p>
      </section>

      {/* NEW: Contact section */}
