import { useState } from "react";
import { motion } from "framer-motion";
import {
  Check,
  Star,
  Shield,
  Zap,
  Phone,
  MessageSquare,
  BarChart3,
  Users,
  CreditCard,
  Mail,
  PlayCircle,
} from "lucide-react";

// --- Quick brand config ---
const BRAND = {
  name: "Remie CRM",
  primary: "from-indigo-500 via-purple-500 to-fuchsia-500",
  accentRing: "ring-indigo-400/50",
  email: "support@remiecrm.com",
};

const PLANS = [
  {
    name: "Solo",
    blurb: "For individual producers ready to ditch spreadsheets.",
    monthly: 49,
    yearly: 39, // per month, billed annually
    features: [
      "Lead inbox & visual pipeline",
      "1,000 contact records",
      "Two-way SMS & email",
      "Task & appointment reminders",
      "Basic dashboards & reports",
      "Unlimited notes & file uploads",
    ],
    ctaNote: "Best for new agents",
  },
  {
    name: "Team",
    blurb: "For small teams that want shared workflows.",
    monthly: 119,
    yearly: 95,
    features: [
      "Everything in Solo",
      "Shared pipelines & calendar",
      "Team inbox + assignment rules",
      "Call queue & power dialer",
      "Role-based permissions",
      "3,000 contact records",
    ],
    seat: { monthly: 19, yearly: 15 },
    ctaNote: "Most popular",
    highlighted: true,
  },
  {
    name: "Agency",
    blurb: "For agencies scaling producers and overrides.",
    monthly: 399,
    yearly: 319,
    features: [
      "Everything in Team",
      "Multi-team workspaces",
      "Commission & override tracking",
      "Advanced analytics & leaderboards",
      "Custom fields & automations",
      "10,000+ contact records",
    ],
    seat: { monthly: 29, yearly: 24 },
    ctaNote: "Scale-ready",
  },
];

export default function App() {
  const [annual, setAnnual] = useState(true);
  const [checkout, setCheckout] = useState({ open: false, plan: null });

  const price = (plan) => (annual ? plan.yearly : plan.monthly);
  const seat = (plan) =>
    plan.seat ? (annual ? plan.seat.yearly : plan.seat.monthly) : null;

  const handleCheckout = (plan) => {
    setCheckout({ open: true, plan });
  };

  return (
    <div className="min-h-screen bg-neutral-950 text-white">
      {/* Gradient backdrop */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-56 left-1/2 h-[36rem] w-[36rem] -translate-x-1/2 rounded-full bg-gradient-to-br from-indigo-600/20 via-fuchsia-500/10 to-rose-500/10 blur-3xl" />
      </div>

      {/* Nav */}
      <header className="relative z-10 border-b border-white/10 backdrop-blur">
        <nav className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <div
              className={`grid h-9 w-9 place-items-center rounded-2xl bg-gradient-to-br ${BRAND.primary} shadow-lg shadow-indigo-700/20 ring-1 ring-white/10`}
            >
              <Zap className="h-5 w-5" />
            </div>
            <span className="font-semibold tracking-tight">{BRAND.name}</span>
          </div>
          <div className="hidden items-center gap-8 md:flex">
            <a href="#features" className="opacity-80 hover:opacity-100">
              Features
            </a>
            <a href="#pricing" className="opacity-80 hover:opacity-100">
              Pricing
            </a>
            <a href="#faq" className="opacity-80 hover:opacity-100">
              FAQ
            </a>
            <a href="#contact" className="opacity-80 hover:opacity-100">
              Contact
            </a>
          </div>
        </nav>
      </header>

      {/* Hero */}
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
            {BRAND.name} is the modern CRM built for life insurance producers
            and agencies—lead capture, follow-up, and policy tracking in one
            lightning-fast workspace.
          </p>
        </div>
      </section>

      {/* Pricing */}
      <section
        id="pricing"
        className="relative z-10 mx-auto max-w-7xl px-6 py-14"
      >
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            Simple, transparent pricing
          </h2>
          <p className="mt-2 text-white/70">
            Switch between monthly and annual billing. Annual saves ~20%.
          </p>
          <div className="mt-6 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 p-1 text-sm">
            <button
              onClick={() => setAnnual(false)}
              className={`rounded-full px-3 py-1 transition ${
                !annual ? "bg-white text-black" : "text-white/80"
              }`}
            >
              Monthly
            </button>
            <button
              onClick={() => setAnnual(true)}
              className={`rounded-full px-3 py-1 transition ${
                annual ? "bg-white text-black" : "text-white/80"
              }`}
            >
              Annual
            </button>
          </div>
        </div>

        <div className="mt-10 grid gap-6 md:grid-cols-3">
          {PLANS.map((plan) => (
            <motion.div
              key={plan.name}
              initial={{ opacity: 0, y: 10 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.4 }}
              className={`relative rounded-3xl border ${
                plan.highlighted
                  ? "border-white/30 bg-white/[0.06]"
                  : "border-white/10 bg-white/[0.04]"
              } p-6 shadow-2xl shadow-black/30 ring-1 ${
                plan.highlighted ? BRAND.accentRing : "ring-white/5"
              }`}
            >
              {plan.ctaNote && (
                <div className="absolute -top-3 left-6 rounded-full border border-white/15 bg-white/10 px-3 py-1 text-xs font-medium backdrop-blur">
                  {plan.ctaNote}
                </div>
              )}
              <h3 className="text-xl font-semibold">{plan.name}</h3>
              <p className="mt-1 text-sm text-white/70">{plan.blurb}</p>
              <div className="mt-5 flex items-baseline gap-2">
                <span className="text-4xl font-bold">${price(plan)}</span>
                <span className="text-white/60">
                  /mo {annual && <span className="text-white/40">(annual)</span>}
                </span>
              </div>
              {seat(plan) && (
                <div className="mt-1 text-xs text-white/60">
                  + ${seat(plan)}/seat
                </div>
              )}
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
              <button
                onClick={() => handleCheckout(plan)}
                className={`mt-6 w-full rounded-2xl border border-white/15 px-4 py-3 font-medium hover:bg-white/10 ${
                  plan.highlighted
                    ? `bg-gradient-to-r ${BRAND.primary}`
                    : "bg-white/5"
                }`}
              >
                Buy {plan.name}
              </button>
            </motion.div>
          ))}
        </div>
      </section>
    </div>
  );
}
