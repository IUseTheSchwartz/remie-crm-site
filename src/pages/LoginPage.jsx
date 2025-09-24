// File: src/pages/LoginPage.jsx
import { useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../auth.jsx";
import { startTrialCheckout, getPriceId } from "../lib/billing.js";
import Logo from "../assets/logo-tight.png";

const BRAND = {
  name: "Remie CRM",
  primary: "from-indigo-500 via-purple-500 to-fuchsia-500",
};

export default function LoginPage() {
  const { login } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [params] = useSearchParams();
  const next = params.get("next");           // e.g. "start-trial"
  const priceFromQuery = params.get("price");// explicit price id (optional)

  const from = loc.state?.from?.pathname || "/app";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setErr("");
    setLoading(true);
    try {
      await login({ email, password });

      if (next === "start-trial") {
        try {
          // Prefer the explicit price if it was passed; else fallback to env
          await startTrialCheckout(priceFromQuery || getPriceId());
          return; // will redirect to Stripe
        } catch (e) {
          console.error(e);
          alert(e.message || "Could not start your trial. Please try again.");
          // fall through to normal navigation
        }
      }

      nav(from, { replace: true });
    } catch (e) {
      setErr(e.message || "Login failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen grid place-items-center bg-neutral-950 text-white px-6">
      <div className="w-full max-w-md rounded-3xl border border-white/10 bg-white/[0.03] p-6 ring-1 ring-white/5">
        <div className="mb-4 flex items-center gap-3">
          <div className="grid h-9 w-9 place-items-center">
            <img src={Logo} alt="Logo" className="h-9 w-9 object-contain" />
          </div>
          <div className="text-lg font-semibold">{BRAND.name}</div>
        </div>

        <h1 className="text-2xl font-semibold">Log in</h1>
        <p className="mt-1 text-sm text-white/70">Use the email and password you signed up with.</p>

        {next === "start-trial" && (
          <div className="mt-3 rounded-xl border border-white/10 bg-white/[0.04] p-3 text-xs text-white/80">
            After you log in, we’ll automatically start your <strong>7-day</strong> trial.
          </div>
        )}

        <form onSubmit={handleSubmit} className="mt-6 space-y-4">
          <div>
            <label className="text-sm text-white/70">Email</label>
            <input
              className="mt-1 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 outline-none focus:ring-2 focus:ring-indigo-500/40"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@remiecrm.com"
              required
            />
          </div>
          <div>
            <label className="text-sm text-white/70">Password</label>
            <input
              className="mt-1 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 outline-none focus:ring-2 focus:ring-indigo-500/40"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
            />
          </div>
          {err && <div className="text-sm text-rose-400">{err}</div>}
          <button className="w-full rounded-xl bg-white px-4 py-2 font-medium text-black hover:bg-white/90" disabled={loading}>
            {loading ? "Working..." : "Continue"}
          </button>
        </form>

        <div className="mt-4 text-center text-sm text-white/70">
          New here?{" "}
          <Link
            to={() => {
              const q = new URLSearchParams();
              if (next === "start-trial") q.set("next", "start-trial");
              if (priceFromQuery) q.set("price", priceFromQuery);
              return q.toString() ? `/signup?${q.toString()}` : "/signup";
            }()}
            className="underline"
          >
            Create an account
          </Link>
        </div>

        <div className="mt-3 text-center text-sm">
          <Link to="/" className="text-white/70 hover:text-white">← Back to site</Link>
        </div>
      </div>
    </div>
  );
}
