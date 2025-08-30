// File: src/pages/SettingsPage.jsx
import { useEffect, useState } from "react";
import { supabase } from "../supabaseClient";

export default function SettingsPage() {
  const [user, setUser] = useState(null);
  const [sub, setSub] = useState(null);
  const [loadingSub, setLoadingSub] = useState(true);

  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [pwMsg, setPwMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [cancelMsg, setCancelMsg] = useState("");

  // Calendly
  const calendlyClientId = import.meta.env.VITE_CALENDLY_CLIENT_ID;
  const redirectUri = `${window.location.origin}/.netlify/functions/calendly-auth-callback`;

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
          if (subErr) {
            console.error(subErr);
          }
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
    if (!confirm("Cancel at period end? You will keep access until the end of the current billing period.")) {
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

  // --- Calendly authorize helper (NO scope param) ---
  function getCalendlyAuthorizeUrl(clientId, redirectUri) {
    const base = "https://calendly.com/oauth/authorize";
    const qs = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      redirect_uri: redirectUri,
    });
    return `${base}?${qs.toString()}`;
  }

  const handleConnectCalendly = () => {
    if (!calendlyClientId) {
      alert("Missing VITE_CALENDLY_CLIENT_ID env var");
      return;
    }
    window.location.href = getCalendlyAuthorizeUrl(calendlyClientId, redirectUri);
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

      {/* Calendly connect */}
      <section className="mb-10 rounded-2xl border p-5">
        <h2 className="text-lg font-medium mb-3">Calendly</h2>
        <button
          onClick={handleConnectCalendly}
          className="rounded-xl px-4 py-2 bg-indigo-600 text-white hover:bg-indigo-700"
        >
          Connect Calendly
        </button>
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
