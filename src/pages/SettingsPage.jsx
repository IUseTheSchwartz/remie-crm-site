// File: src/pages/SettingsPage.jsx
import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient"; // adjust if your path differs

export default function SettingsPage() {
  const [user, setUser] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [hasCalendly, setHasCalendly] = useState(false);

  // ---- Your existing account/subscription states (keep yours if you have them) ----
  const [sub, setSub] = useState(null);
  const [loadingSub, setLoadingSub] = useState(true);
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [pwMsg, setPwMsg] = useState("");
  const [cancelMsg, setCancelMsg] = useState("");

  useEffect(() => {
    let ignore = false;
    (async () => {
      const { data, error } = await supabase.auth.getUser();
      if (error) {
        console.error(error);
        return;
      }
      if (ignore) return;
      setUser(data.user || null);

      // check if user already has a Calendly token saved
      if (data.user?.id) {
        const { data: token, error: tErr } = await supabase
          .from("calendly_tokens")
          .select("id")
          .eq("user_id", data.user.id)
          .maybeSingle();
        if (!ignore) {
          if (tErr) console.error(tErr);
          setHasCalendly(!!token);
        }
      }

      // (Optional) load your subscription UI like you had before
      if (data.user?.id) {
        setLoadingSub(true);
        const { data: subData, error: subErr } = await supabase
          .from("subscriptions")
          .select("*")
          .eq("user_id", data.user.id)
          .maybeSingle();
        if (!ignore) {
          if (subErr) console.error(subErr);
          setSub(subData || null);
          setLoadingSub(false);
        }
      } else {
        setLoadingSub(false);
      }
    })();
    return () => {
      ignore = true;
    };
  }, []);

  const VITE_CLIENT_ID = import.meta.env.VITE_CALENDLY_CLIENT_ID;
  const SITE_URL = import.meta.env.VITE_SITE_URL || window.location.origin;
  const REDIRECT_URI = `${SITE_URL}/.netlify/functions/calendly-auth-callback`;

  const connectCalendly = () => {
    setMsg("");
    if (!VITE_CLIENT_ID) {
      setMsg("Missing VITE_CALENDLY_CLIENT_ID env var.");
      return;
    }

    // Use Calendly's auth server + valid scopes
    const scopes = [
      "users:read",
      "scheduled_events:read",
      "event_types:read",
      "organization:read",
    ].join(" ");

    const authorizeUrl = new URL("https://auth.calendly.com/oauth/authorize");
    authorizeUrl.searchParams.set("client_id", VITE_CLIENT_ID);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
    authorizeUrl.searchParams.set("scope", scopes);

    window.location.href = authorizeUrl.toString();
  };

  const disconnectCalendly = async () => {
    if (!user?.id) return;
    setBusy(true);
    setMsg("");
    try {
      const { error } = await supabase
        .from("calendly_tokens")
        .delete()
        .eq("user_id", user.id);
      if (error) throw error;
      setHasCalendly(false);
      setMsg("Calendly disconnected.");
    } catch (err) {
      setMsg(err.message || "Failed to disconnect Calendly.");
    } finally {
      setBusy(false);
    }
  };

  // ----- Your existing handlers (password, cancel subscription) -----
  const onChangePassword = async (e) => {
    e.preventDefault();
    setPwMsg("");
    if (!pw || pw.length < 8) {
      setPwMsg("Password must be at least 8 characters.");
      return;
    }
    if (pw !== pw2) {
      setPwMsg("Passwords do not match.");
      return;
    }
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password: pw });
    setBusy(false);
    if (error) {
      setPwMsg(error.message || "Failed to update password.");
    } else {
      setPw("");
      setPw2("");
      setPwMsg("Password updated.");
    }
  };

  const onCancelSubscription = async () => {
    if (!user?.id) return;
    if (!sub?.stripe_subscription_id) {
      setCancelMsg("No active subscription found.");
      return;
    }
    if (!confirm("Cancel at period end?")) return;
    setBusy(true);
    setCancelMsg("");
    try {
      const res = await fetch("/.netlify/functions/cancel-subscription", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: user.id }),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(text || "Cancel failed");
      setCancelMsg("Your subscription will be canceled at the period end.");
      const { data: subData } = await supabase
        .from("subscriptions")
        .select("*")
        .eq("user_id", user.id)
        .maybeSingle();
      setSub(subData || null);
    } catch (err) {
      setCancelMsg(err.message || "Cancel failed.");
    } finally {
      setBusy(false);
    }
  };

  const fmtDate = (iso) => {
    if (!iso) return "—";
    try { return new Date(iso).toLocaleString(); } catch { return iso; }
  };

  return (
    <div className="max-w-3xl mx-auto p-6">
      <h1 className="text-2xl font-semibold mb-6">Settings</h1>

      {/* Calendly */}
      <section className="mb-10 rounded-2xl border p-5">
        <h2 className="text-lg font-medium mb-3">Calendly</h2>
        <p className="text-sm text-gray-500 mb-3">
          Connect your Calendly account to show your meetings inside the CRM.
        </p>
        <div className="flex items-center gap-3">
          {!hasCalendly ? (
            <button
              onClick={connectCalendly}
              className="rounded-xl px-4 py-2 bg-black text-white"
            >
              Connect Calendly
            </button>
          ) : (
            <button
              onClick={disconnectCalendly}
              disabled={busy}
              className="rounded-xl px-4 py-2 border hover:bg-gray-50 disabled:opacity-50"
            >
              {busy ? "Working…" : "Disconnect Calendly"}
            </button>
          )}
          {msg && <div className="text-sm">{msg}</div>}
        </div>
        <div className="mt-2 text-xs text-gray-500">
          Redirect URI: <code>{REDIRECT_URI}</code>
        </div>
      </section>

      {/* Account */}
      <section className="mb-10 rounded-2xl border p-5">
        <h2 className="text-lg font-medium mb-3">Account</h2>
        <div className="space-y-2">
          <div>
            <div className="text-sm text-gray-500">Email</div>
            <div className="font-medium">{user?.email || "—"}</div>
          </div>
        </div>
      </section>

      {/* Change Password */}
      <section className="mb-10 rounded-2xl border p-5">
        <h2 className="text-lg font-medium mb-3">Change password</h2>
        <form onSubmit={onChangePassword} className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <input
              type="password"
              className="border rounded-xl px-3 py-2"
              placeholder="New password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              minLength={8}
              required
            />
            <input
              type="password"
              className="border rounded-xl px-3 py-2"
              placeholder="Confirm new password"
              value={pw2}
              onChange={(e) => setPw2(e.target.value)}
              minLength={8}
              required
            />
          </div>
          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={busy}
              className="rounded-xl px-4 py-2 bg-black text-white disabled:opacity-50"
            >
              {busy ? "Saving..." : "Update password"}
            </button>
            {pwMsg && <div className="text-sm">{pwMsg}</div>}
          </div>
        </form>
      </section>

      {/* Subscription */}
      <section className="mb-10 rounded-2xl border p-5">
        <h2 className="text-lg font-medium mb-3">Subscription</h2>
        {loadingSub ? (
          <div>Loading subscription…</div>
        ) : sub ? (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-4">
              <Info label="Plan" value={sub.plan || "—"} />
              <Info label="Status" value={sub.status || "—"} />
              <Info label="Renews / ends" value={fmtDate(sub.current_period_end)} />
            </div>
            <div className="mt-4 flex flex-wrap gap-3">
              <button
                onClick={onCancelSubscription}
                disabled={busy}
                className="rounded-xl px-4 py-2 border hover:bg-gray-50 disabled:opacity-50"
              >
                {busy ? "Working…" : "Cancel subscription"}
              </button>
              {cancelMsg && <div className="text-sm">{cancelMsg}</div>}
            </div>
          </div>
        ) : (
          <div>No active subscription found.</div>
        )}
      </section>
    </div>
  );
}

function Info({ label, value }) {
  return (
    <div>
      <div className="text-sm text-gray-500">{label}</div>
      <div className="font-medium">{value}</div>
    </div>
  );
}
