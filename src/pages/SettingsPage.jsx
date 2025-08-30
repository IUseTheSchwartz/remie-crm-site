// File: src/pages/SettingsPage.jsx
import { useEffect, useMemo, useState } from "react";
import { supabase } from "../supabaseClient";

// Calendly OAuth constants (from Calendly docs)
const CALENDLY_AUTH_HOST = "https://auth.calendly.com"; // must be EXACT
// Minimal scopes to read upcoming meetings. Add more later if you need:
const CALENDLY_SCOPES = [
  "users.read",
  "scheduled_events.read",
  "event_types.read",
  "organization.read",
];

export default function SettingsPage() {
  const [user, setUser] = useState(null);
  const [sub, setSub] = useState(null);
  const [loadingSub, setLoadingSub] = useState(true);

  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [pwMsg, setPwMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [cancelMsg, setCancelMsg] = useState("");

  // ---- Calendly client id (public Vite var) ----
  const clientId = import.meta.env.VITE_CALENDLY_CLIENT_ID;

  // We’ll use the deployed site URL (Netlify var) if present; otherwise origin.
  const siteUrl =
    import.meta.env.VITE_SITE_URL?.replace(/\/$/, "") ||
    (typeof window !== "undefined" ? window.location.origin : "");
  // Callback is a Netlify function:
  const redirectUri = `${siteUrl}/.netlify/functions/calendly-auth-callback`;

  useEffect(() => {
    let ignore = false;

    async function load() {
      const { data, error } = await supabase.auth.getUser();
      if (error) {
        console.error(error);
        return;
      }
      if (ignore) return;
      setUser(data.user || null);

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
    }

    load();
    return () => {
      ignore = true;
    };
  }, []);

  // Build the authorize URL exactly as Calendly expects.
  const authorizeUrl = useMemo(() => {
    if (!clientId || !redirectUri) return "";
    const url = new URL("/oauth/authorize", CALENDLY_AUTH_HOST);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", redirectUri);
    // space-separated scopes (Calendly expects spaces, not commas)
    url.searchParams.set("scope", CALENDLY_SCOPES.join(" "));
    // include state to map back to the supabase user
    if (user?.id) url.searchParams.set("state", user.id);
    return url.toString();
  }, [clientId, redirectUri, user?.id]);

  const connectCalendly = () => {
    if (!clientId) {
      alert("Missing VITE_CALENDLY_CLIENT_ID in your Netlify/Vite env vars.");
      return;
    }
    if (!siteUrl) {
      alert("Missing site URL to build redirect URI.");
      return;
    }
    window.location.assign(authorizeUrl);
  };

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
    if (
      !confirm(
        "Cancel at period end? You will keep access until the end of the current billing period."
      )
    ) {
      return;
    }
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
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
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

      {/* Calendly OAuth */}
      <section className="mb-10 rounded-2xl border p-5">
        <h2 className="text-lg font-medium mb-3">Calendly</h2>
        <p className="text-sm text-gray-600 mb-3">
          Connect your Calendly account to sync meetings into your CRM.
        </p>
        <div className="flex gap-3">
          <button
            onClick={connectCalendly}
            className="rounded-xl px-4 py-2 bg-blue-600 text-white"
          >
            Connect Calendly
          </button>
          <a
            href="https://developer.calendly.com/api-docs/ZG9jOjU5NDA3-oauth-20"
            target="_blank"
            rel="noreferrer"
            className="text-sm underline opacity-70 hover:opacity-100"
          >
            Calendly OAuth docs
          </a>
        </div>
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
