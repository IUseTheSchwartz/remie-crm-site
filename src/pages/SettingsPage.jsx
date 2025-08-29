// File: src/pages/SettingsPage.jsx
import { useEffect, useState } from "react";
import { useAuth } from "../auth.jsx";
import { supabase } from "../supabaseClient"; // make sure this exists

function Card({ title, children }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 ring-1 ring-white/5">
      <div className="mb-2 text-sm font-semibold">{title}</div>
      <div className="text-sm text-white/80">{children}</div>
    </div>
  );
}

function Field({ label, hint, children }) {
  return (
    <label className="block">
      <div className="mb-1 text-sm text-white/70">{label}</div>
      {children}
      {hint && <div className="mt-1 text-xs text-white/50">{hint}</div>}
    </label>
  );
}

export default function SettingsPage() {
  const { user } = useAuth();
  const [sub, setSub] = useState(null);
  const [loadingSub, setLoadingSub] = useState(true);

  // Change password state
  const [pwd, setPwd] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  // Load subscription row for this user (if table exists)
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { data: u } = await supabase.auth.getUser();
        const userId = u?.user?.id;
        if (!userId) {
          if (alive) setLoadingSub(false);
          return;
        }
        const { data, error } = await supabase
          .from("subscriptions")
          .select("*")
          .eq("user_id", userId)
          .maybeSingle();
        if (alive) {
          if (!error) setSub(data || null);
          setLoadingSub(false);
        }
      } catch {
        if (alive) setLoadingSub(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  async function changePassword(e) {
    e.preventDefault();
    setMsg("");
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password: pwd });
    setBusy(false);
    setPwd("");
    setMsg(error ? error.message : "Password updated.");
  }

  return (
    <div className="grid gap-6 md:grid-cols-2">
      {/* Account */}
      <Card title="Account">
        <div className="space-y-3">
          <Field label="Login email">
            <input
              readOnly
              value={user?.email || ""}
              className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm opacity-80"
            />
          </Field>

          {/* For security, we never show the current password */}
          <form onSubmit={changePassword} className="space-y-2">
            <Field label="New password" hint="8+ characters. This will log out other sessions.">
              <input
                type="password"
                minLength={8}
                required
                value={pwd}
                onChange={(e) => setPwd(e.target.value)}
                className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500/40"
              />
            </Field>
            <button
              disabled={busy}
              className="rounded-xl bg-white px-4 py-2 text-sm font-medium text-black hover:bg-white/90 disabled:opacity-50"
            >
              {busy ? "Updating…" : "Change password"}
            </button>
            {msg && <div className="text-xs text-white/70">{msg}</div>}
          </form>
        </div>
      </Card>

      {/* Subscription */}
      <Card title="Subscription">
        {loadingSub ? (
          <div className="text-sm text-white/60">Loading…</div>
        ) : sub ? (
          <div className="space-y-2">
            <div>
              <span className="text-white/60">Plan:</span> {sub.plan || "Unknown"}
            </div>
            <div>
              <span className="text-white/60">Status:</span> {sub.status || "unknown"}
            </div>
            {sub.current_period_end && (
              <div>
                <span className="text-white/60">Renews:</span>{" "}
                {new Date(sub.current_period_end).toLocaleString()}
              </div>
            )}
            <div className="text-xs text-white/50">
              To change/cancel, use the billing portal (we can add that button next).
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="text-sm">No active subscription found.</div>
            <a href="/" className="inline-block rounded-xl bg-white px-3 py-2 text-sm font-medium text-black">
              Choose a plan
            </a>
          </div>
        )}
      </Card>
    </div>
  );
}

import { useState } from "react";
import { useAuth } from "../auth"; // assuming you have auth context

function Settings() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(false);

  const handleCancel = async () => {
    setLoading(true);
    try {
      const res = await fetch("/.netlify/functions/cancel-subscription", {
        method: "POST",
        body: JSON.stringify({ user_id: user.id }),
      });

      if (res.ok) {
        alert("Your subscription will be canceled at the end of the billing period.");
      } else {
        const err = await res.text();
        alert("Error: " + err);
      }
    } catch (e) {
      alert("Request failed: " + e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <h2>Settings</h2>
      <p>Email: {user?.email}</p>
      <button onClick={handleCancel} disabled={loading}>
        {loading ? "Cancelling..." : "Cancel Subscription"}
      </button>
    </div>
  );
}

export default Settings;

