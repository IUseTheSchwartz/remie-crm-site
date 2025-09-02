// File: src/App.jsx
import { useState, useEffect } from "react";
import { Routes, Route, Link, Navigate, useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import {
  Check,
  Zap,
  LogOut,
  Phone,
  Shield,
  Star,
  CreditCard,
  ExternalLink,
} from "lucide-react";

import ProtectedRoute from "./components/ProtectedRoute.jsx";
import { AuthProvider, useAuth } from "./auth.jsx";
import LoginPage from "./pages/LoginPage.jsx";
import SignupPage from "./pages/SignupPage.jsx";
import AgentPublic from "./pages/AgentPublic.jsx";

// Supabase
import { supabase } from "./lib/supabaseClient.js";

// Routes config (component refs, no JSX inside)
import { routes } from "./routesConfig.js";

// Brand / theme
const BRAND = {
  name: "Remie CRM",
  primary: "from-indigo-500 via-purple-500 to-fuchsia-500",
  accentRing: "ring-indigo-400/50",
};

// ---------- Pricing cards data ----------
const PLANS = [
  {
    name: "Mail List",
    blurb: "Hands-off client touchpoints with auto birthday & holiday mailers.",
    monthly: 100,
    yearly: null, // no annual plan
    buyUrl: {
      monthly: "https://buy.stripe.com/7sY9AV7KO9M22su2qg8Ra09",
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
    name: "Remie CRM",
    blurb:
      "All-in-one CRM for agents — pipeline, dialer, automations, and more.",
    monthly: 280,
    yearly: 250, // shown as per-month when “Annual” is selected
    buyUrl: {
      monthly: "https://buy.stripe.com/28E4gB8OScYeffg2qg8Ra07",
      annual: "https://buy.stripe.com/8x2cN7aX0e2i9UW2qg8Ra08",
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
    ctaNote: "Best for agents & small teams",
    highlighted: true,
  },
];

// ---------- Landing Page ----------
function LandingPage() {
  const [annual, setAnnual] = useState(true);

  // Show annual price if available and annual is toggled; otherwise monthly
  const displayPrice = (plan) =>
    annual && plan.yearly != null ? plan.yearly : plan.monthly;

  // Choose the correct Stripe link; if annual not available, fall back to monthly
  const buyHref = (plan) =>
    annual && plan.buyUrl?.annual ? plan.buyUrl.annual : plan.buyUrl?.monthly;

  return (
    <div className="min-h-screen bg-neutral-950 text-white">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-56 left-1/2 h-[36rem] w-[36rem] -translate-x-1/2 rounded-full bg-gradient-to-br from-indigo-600/20 via-fuchsia-500/10 to-rose-500/10 blur-3xl" />
      </div>

      <header className="relative z-10 border-b border-white/10 backdrop-blur">
        <nav className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <div
              className={`grid h-9 w-9 place-items-center rounded-2xl bg-gradient-to-br ${BRAND.primary} ring-1 ring-white/10`}
            >
              <Zap className="h-5 w-5" />
            </div>
            <span className="font-semibold tracking-tight">{BRAND.name}</span>
          </div>
          <div className="flex items-center gap-3">
            <Link to="/login" className="text-sm opacity-80 hover:opacity-100">
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
            Choose the plan that fits your workflow—stay in touch automatically,
            run a clean solo pipeline, or plug your whole team into one system.
          </p>
          <div className="mt-6 flex items-center justify-center gap-6 text-xs text-white/60">
            <span className="inline-flex items-center gap-1">
              <Star className="h-4 w-4" /> Concierge migration (Remie CRM)
            </span>
            <span className="inline-flex items-center gap-1">
              <Phone className="h-4 w-4" /> Click-to-call & power dialer
            </span>
            <span className="inline-flex items-center gap-1">
              <Shield className="h-4 w-4" /> Bootcamp for new features
            </span>
          </div>
        </div>
      </section>

      <section id="pricing" className="relative z-10 mx-auto max-w-7xl px-6 py-14">
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
              title="Some plans may not have an annual option"
            >
              Annual
            </button>
          </div>
        </div>

        <div className="mt-10 grid gap-6 md:grid-cols-2">
          {PLANS.map((plan) => {
            const isAnnualShown = annual && plan.yearly != null;
            const price = displayPrice(plan);
            const href = buyHref(plan);

            return (
              <div
                key={plan.name}
                className={`relative rounded-3xl border 
                  ${
                    plan.highlighted
                      ? "border-white/30 bg-white/[0.06]"
                      : "border-white/10 bg-white/[0.04]"
                  } 
                  p-6 ring-1 transition 
                  ${
                    plan.highlighted ? BRAND.accentRing : "ring-white/5"
                  } hover:border-white/30 hover:bg-white/[0.08] hover:ring-indigo-400/50`}
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
                    {!isAnnualShown && annual && plan.yearly == null && (
                      <span className="ml-2 rounded-full border border-white/15 bg-white/10 px-2 py-0.5 text-[11px] text-white/60">
                        monthly only
                      </span>
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
                    bg-white/5 hover:bg-gradient-to-r ${BRAND.primary} hover:text-white`}
                >
                  <CreditCard className="mr-2 h-5 w-5" /> Buy {plan.name}
                </a>
              </div>
            );
          })}
        </div>

        <p className="mt-6 text-center text-xs text-white/50">
          Prices in USD. Annual pricing shows per-month equivalent, billed
          annually (where available).
        </p>
      </section>

      <footer className="relative z-10 border-t border-white/10 bg-black/40">
        <div className="mx-auto max-w-7xl px-6 py-6 text-center text-xs text-white/60">
          © {new Date().getFullYear()} {BRAND.name}. All rights reserved.
        </div>
      </footer>
    </div>
  );
}

// ---------- Sidebar Link ----------
function DashLink({ to, children }) {
  return (
    <Link
      to={to}
      className="block rounded-lg px-3 py-2 text-white/80 hover:bg-white/5 hover:text-white"
    >
      {children}
    </Link>
  );
}

// ---------- ViewAgentSiteLink ----------
function ViewAgentSiteLink() {
  const [slug, setSlug] = useState("");
  const [published, setPublished] = useState(false);
  const [loading, setLoading] = useState(true);

  async function fetchProfile() {
    try {
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth?.user?.id;
      if (!uid) {
        setSlug("");
        setPublished(false);
        return;
      }
      const { data, error } = await supabase
        .from("agent_profiles")
        .select("slug, published")
        .eq("user_id", uid)
        .maybeSingle();

      if (!error && data) {
        setSlug(data.slug || "");
        setPublished(!!data.published);
      } else {
        setSlug("");
        setPublished(false);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let isMounted = true;
    (async () => {
      await fetchProfile();

      const channel = supabase
        .channel("agent_profiles_self")
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "agent_profiles" },
          async () => {
            if (!isMounted) return;
            await fetchProfile();
          }
        )
        .subscribe();

      const onStorage = (e) => {
        if (e.key === "agent_profile_refresh") {
          fetchProfile();
        }
      };
      window.addEventListener("storage", onStorage);

      return () => {
        isMounted = false;
        try {
          supabase.removeChannel?.(channel);
        } catch {}
        window.removeEventListener("storage", onStorage);
      };
    })();
  }, []);

  if (loading) {
    return (
      <div className="block rounded-lg px-3 py-2 text-white/40 cursor-default">
        View My Agent Site…
      </div>
    );
  }

  if (!slug) {
    return (
      <Link
        to="/app/agent/showcase"
        className="flex items-center gap-2 rounded-lg px-3 py-2 text-amber-300/90 hover:bg-white/5"
        title="Finish setup to generate your public link"
      >
        <ExternalLink className="h-4 w-4" />
        <span>Finish Agent Site Setup</span>
      </Link>
    );
  }

  // Use absolute URL + cache-buster so it always opens cleanly in a new tab
  const href = `${window.location.origin}/a/${slug}?t=${Date.now()}`;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="flex items-center gap-2 rounded-lg px-3 py-2 text-white/80 hover:bg-white/5 hover:text-white"
      title={published ? "Open your public agent page" : "Open preview (publish in the wizard)"}
    >
      <ExternalLink className="h-4 w-4" />
      <span>{published ? "View My Agent Site" : "Preview My Agent Site"}</span>
    </a>
  );
}

// ---------- App Layout (sidebar + routes) ----------
function AppLayout() {
  const { user, logout } = useAuth();
  const nav = useNavigate();

  return (
    <div className="min-h-screen bg-neutral-950 text-white grid md:grid-cols-[240px_1fr]">
      <aside className="hidden md:block border-r border-white/10 bg-black/30">
        <a
          href="https://remiecrm.com"
          target="_blank"
          rel="noopener noreferrer"
          className="p-4 flex items-center gap-3 border-b border-white/10"
        >
          <div
            className={`grid h-9 w-9 place-items-center rounded-2xl bg-gradient-to-br ${BRAND.primary} ring-1 ring-white/10`}
          >
            <Zap className="h-5 w-5" />
          </div>
          <div className="font-semibold">{BRAND.name}</div>
        </a>
        <nav className="p-3 space-y-1 text-sm">
          {routes
            .filter((r) => r.showInSidebar && r.group !== "agent")
            .map((r) => (
              <DashLink key={r.path} to={r.path}>
                {r.label}
              </DashLink>
            ))}

          <div className="pt-2 mt-2 border-t border-white/10" />
          <ViewAgentSiteLink />

          {routes
            .filter((r) => r.showInSidebar && r.group === "agent")
            .map((r) => (
              <DashLink key={r.path} to={r.path}>
                {r.label}
              </DashLink>
            ))}
        </nav>
      </aside>

      <main>
        <div className="flex items-center justify-between border-b border-white/10 bg-black/30 px-4 py-3">
          <div className="font-medium">
            Welcome{user?.email ? `, ${user.email}` : ""}
          </div>
          <button
            onClick={async () => {
              await logout();
              nav("/");
            }}
            className="inline-flex items-center gap-2 rounded-lg border border-white/15 px-3 py-1.5 text-sm hover:bg-white/5"
          >
            <LogOut className="h-4 w-4" /> Log out
          </button>
        </div>

        <div className="p-4">
          <Routes>
            {routes.map((r) => {
              const C = r.component;
              return r.index ? (
                <Route key={r.key} index element={<C />} />
              ) : (
                <Route
                  key={r.key}
                  path={r.path.replace("/app/", "")}
                  element={<C />}
                />
              );
            })}
          </Routes>
        </div>
      </main>
    </div>
  );
}

// ---------- App root ----------
export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/signup" element={<SignupPage />} />

        {/* public agent page */}
        <Route path="/a/:slug" element={<AgentPublic />} />

        <Route element={<ProtectedRoute />}>
          <Route path="/app/*" element={<AppLayout />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  );
}
