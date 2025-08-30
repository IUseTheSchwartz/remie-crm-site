// File: src/pages/SettingsPage.jsx
import { useEffect, useMemo, useState } from "react";
import { supabase } from "../supabaseClient";

// ---------- Small helpers ----------
function Info({ label, value }) {
  return (
    <div>
      <div className="text-sm text-gray-500">{label}</div>
      <div className="font-medium">{value}</div>
    </div>
  );
}

export default function SettingsPage() {
  const [user, setUser] = useState(null);
  const [sub, setSub] = useState(null);
  const [loadingSub, setLoadingSub] = useState(true);

  // Password
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [pwMsg, setPwMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [cancelMsg, setCancelMsg] = useState("");

  // Calendly
  const [calToken, setCalToken] = useState(null);
  const [calMsg, setCalMsg] = useState("");
  const clientId = import.meta.env.VITE_CALENDLY_CLIENT_ID;
  const siteUrl = window.location.origin;
  const redirectUri = `${siteUrl}/.netlify/functions/calendly-auth-callback`;

  // These scopes are fine for reading the user and events
  const calendlyScopes = useMemo(
    () =>
      [
        "users:read",
        "scheduled_events:read",
        "event_types:read",
        "organization:read",
      ].join(" "),
    []
  );

  useEffect(() => {
    let ignore = false;

    (async () => {
      // Auth user
      const { data, error } = await supabase.auth.getUser();
      if (!error) setUser(data.user || null);

      if (data.user?.id) {
        // Subscription
        setLoadingSub(true);
        const { data: subRow } = await supabase
          .from("subscriptions")
          .select("*")
          .eq("user_id", data.user.id)
          .maybeSingle();
        setSub(subRow || null);
        setLoadingSub(false);

        // Calendly token (if stored)
        const { data: tokenRow } = await supabase
          .from("calendly_tokens")
          .select("access_token")
          .eq("user_id", data.user.id)
          .maybeSingle();
        setCalToken(tokenRow?.access_token || null);
      }

      // Handle OAuth callback (token in URL hash)
      const hash = window.location.hash || "";
      if (hash.startsWith("#calendly_oauth=")) {
        const parts = Object.fromEntries(
          hash
            .slice(1)
            .split("&")
            .map((kv) => kv.split("=").map(decodeURIComponent))
        );
        if (parts.calendly_oauth === "success" && parts.access_token) {
          if (!ignore && data.user?.id) {
            await supabase
              .from("calendly_tokens")
              .upsert({
                user_id: data.user.id,
                access_token: parts.access_token,
                // Optional: store refresh_token & expires_in if you plan to refresh
                refresh_token: parts.refresh_token || null,
              })
              .eq("user_id", data.user.id);
            setCalToken(parts.access_token);
            setCalMsg("Calendly connected.");
            // Clean up hash
            history.replaceState(null, "", window.location.pathname);
          }
        } else if (parts.calendly_oauth) {
          setCalMsg("Calendly authorization failed.");
          history.replaceState(null, "", window.location.pathname);
        }
      }
    })();

    return () => {
      ignore = true;
    };
  }, []);

  // ---------- Password ----------
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
    if (error) setPwMsg(error.message || "Failed to update password.");
    else {
      setPw(""); setPw2(""); setPwMsg("Password updated.");
    }
  };

  // ---------- Subscription ----------
  const fmtDate = (iso) => {
    if (!iso) return "—";
    try { return new Date(iso).toLocaleString(); } catch { return iso; }
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
      const { data: subRow } = await supabase
        .from("subscriptions")
        .select("*").eq("user_id", user.id).maybeSingle();
      setSub(subRow || null);
    } catch (err) {
      setCancelMsg(err.message || "Cancel failed.");
    } finally {
      setBusy(false);
    }
  };

  // ---------- Calendly ----------
  const connectCalendly = () => {
    if (!clientId) {
      alert("Missing VITE_CALENDLY_CLIENT_ID env var.");
      return;
    }
    // Build authorize URL exactly as Calendly expects
    const url = new URL("https://calendly.com/oauth/authorize");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", calendlyScopes);
    window.location.assign(url.toString());
  };

  const disconnectCalendly = async () => {
    if (!user?.id) return;
    await supabase.from("calendly_tokens").delete().eq("user_id", user.id);
    setCalToken(null);
    setCalMsg("Calendly disconnected.");
  };

  return (
    <div className="max-w-3xl mx-auto p-6">
      <h1 className="text-2xl font-semibold mb-6">Settings</h1>

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
            <input type="password" className="border rounded-xl px-3 py-2"
              placeholder="New password" value={pw}
              onChange={(e) => setPw(e.target.value)} minLength={8} required />
            <input type="password" className="border rounded-xl px-3 py-2"
              placeholder="Confirm new password" value={pw2}
              onChange={(e) => setPw2(e.target.value)} minLength={8} required />
          </div>
          <div className="flex items-center gap-3">
            <button type="submit" disabled={busy}
              className="rounded-xl px-4 py-2 bg-black text-white disabled:opacity-50">
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
              <button onClick={onCancelSubscription} disabled={busy}
                className="rounded-xl px-4 py-2 border hover:bg-gray-50 disabled:opacity-50">
                {busy ? "Working…" : "Cancel subscription"}
              </button>
              {cancelMsg && <div className="text-sm">{cancelMsg}</div>}
            </div>
          </div>
        ) : (
          <div>No active subscription found.</div>
        )}
      </section>

      {/* Calendly */}
      <section className="mb-10 rounded-2xl border p-5">
        <h2 className="text-lg font-medium mb-3">Calendly</h2>
        <p className="text-sm text-gray-600 mb-3">
          Connect your Calendly to show meetings in the CRM.
        </p>
        {calToken ? (
          <div className="flex items-center gap-3">
            <span className="text-green-600 text-sm">Connected</span>
            <button onClick={disconnectCalendly}
              className="rounded-xl px-4 py-2 border hover:bg-gray-50">
              Disconnect
            </button>
          </div>
        ) : (
          <button onClick={connectCalendly}
            className="rounded-xl px-4 py-2 bg-black text-white">
            Connect Calendly
          </button>
        )}
        {calMsg && <div className="mt-2 text-sm">{calMsg}</div>}
      </section>
    </div>
  );
}
