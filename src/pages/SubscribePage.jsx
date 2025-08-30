// File: src/pages/SubscribePage.jsx
import { Link } from "react-router-dom";
import { CreditCard, Zap } from "lucide-react";

const BRAND = {
  name: "Remie CRM",
  primary: "from-indigo-500 via-purple-500 to-fuchsia-500",
};

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
    ctaNote: "Stay top-of-mind",
    features: [
      "Automatic birthday letters for each contact",
      "Automatic holiday greetings",
      "Upload CSV and set-it-and-forget-it",
      "Custom message templates",
      "Activity log",
    ],
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
    ctaNote: "Best for solo agents",
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
    ctaNote: "For growing agencies",
    highlighted: true,
    features: [
      "Everything in Basic",
      "Unlimited team access",
      "Concierge migration",
      "Shared inbox & calendars",
    ],
  },
];

export default function SubscribePage() {
  const annual = true; // present annual by default here
  const price = (plan) => (annual ? plan.yearly : plan.monthly);

  return (
    <div className="min-h-screen bg-neutral-950 text-white">
      <header className="border-b border-white/10 bg-black/50 backdrop-blur">
        <nav className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2">
            <div className={`grid h-8 w-8 place-items-center rounded-2xl bg-gradient-to-br ${BRAND.primary} ring-1 ring-white/10`}>
              <Zap className="h-4 w-4" />
            </div>
            <div className="text-sm font-semibold tracking-tight">{BRAND.name}</div>
          </div>
          <Link to="/app/settings" className="text-xs text-white/70 hover:text-white">Account</Link>
        </nav>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-10">
        <h1 className="text-2xl font-semibold">Choose a plan to continue</h1>
        <p className="mt-2 text-sm text-white/70">You need an active subscription to access the app.</p>

        <div className="mt-8 grid gap-6 md:grid-cols-3">
          {PLANS.map((plan) => (
            <div key={plan.name}
              className={`relative rounded-3xl border ${plan.highlighted ? "border-white/30 bg-white/[0.06]" : "border-white/10 bg-white/[0.04]"} p-6 ring-1 ${plan.highlighted ? "ring-indigo-400/50" : "ring-white/5"}`}>
              {plan.ctaNote && (
                <div className="absolute -top-3 left-6 rounded-full border border-white/15 bg-white/10 px-3 py-1 text-xs font-medium backdrop-blur">
                  {plan.ctaNote}
                </div>
              )}
              <h3 className="text-xl font-semibold">{plan.name}</h3>
              <p className="mt-1 text-sm text-white/70">{plan.blurb}</p>
              <div className="mt-5 flex items-baseline gap-2">
                <span className="text-4xl font-bold">${price(plan)}</span>
                <span className="text-white/60">/mo <span className="text-white/40">(annual)</span></span>
              </div>
              <ul className="mt-6 space-y-2 text-sm">
                {plan.features.map((f) => (
                  <li key={f} className="flex items-start gap-2">
                    <span className="mt-0.5 rounded-full bg-white/10 p-1 ring-1 ring-white/10" />
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
              <a
                href={plan.buyUrl?.annual}
                target="_blank" rel="noreferrer"
                className={`mt-6 grid w-full place-items-center rounded-2xl border border-white/15 px-4 py-3 font-medium hover:bg-white/10 ${plan.highlighted ? `bg-gradient-to-r ${BRAND.primary}` : "bg-white/5"}`}>
                <CreditCard className="mr-2 h-5 w-5" /> Buy {plan.name}
              </a>
            </div>
          ))}
        </div>

        <p className="mt-6 text-center text-xs text-white/50">Prices in USD. Annual pricing shows per-month equivalent, billed annually.</p>
      </main>
    </div>
  );
}
