// File: src/pages/Wallet.jsx
import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import {
  CreditCard,
  Loader2,
  Check,
  PlusCircle,
  RefreshCcw,
} from "lucide-react";

export default function WalletPage() {
  const [loading, setLoading] = useState(true);
  const [userId, setUserId] = useState(null);

  const [balanceCents, setBalanceCents] = useState(0);
  const [topping, setTopping] = useState(false);

  const [txLoading, setTxLoading] = useState(true);
  const [txError, setTxError] = useState("");
  const [transactions, setTransactions] = useState([]);

  const [customUsd, setCustomUsd] = useState("");
  const [customMsg, setCustomMsg] = useState("");

  // Auto-recharge settings
  const [autoTriggerUsd, setAutoTriggerUsd] = useState("");
  const [autoAmountUsd, setAutoAmountUsd] = useState("");
  const [autoMsg, setAutoMsg] = useState("");

  // Minimum top-up is $10
  const MIN_CENTS = 1000;
  const MAX_CENTS = 50000;

  useEffect(() => {
    let mounted = true;
    (async () => {
      setLoading(true);
      const { data: sessionData } = await supabase.auth.getSession();
      const uid = sessionData?.session?.user?.id || null;
      if (!uid) {
        setLoading(false);
        return;
      }
      if (!mounted) return;
      setUserId(uid);

      // Load wallet + subscription data
      const { data: wallet } = await supabase
        .from("user_wallets")
        .select(
          "balance_cents, auto_recharge_threshold_cents, auto_recharge_amount_cents"
        )
        .eq("user_id", uid)
        .maybeSingle();

      const { data: subscription } = await supabase
        .from("subscriptions")
        .select("auto_recharge_threshold_cents, auto_recharge_amount_cents")
        .eq("user_id", uid)
        .maybeSingle();

      const threshold =
        subscription?.auto_recharge_threshold_cents ??
        wallet?.auto_recharge_threshold_cents ??
        0;
      const amount =
        subscription?.auto_recharge_amount_cents ??
        wallet?.auto_recharge_amount_cents ??
        0;

      if (!mounted) return;
      setBalanceCents(wallet?.balance_cents || 0);
      setAutoTriggerUsd((threshold || 0) / 100);
      setAutoAmountUsd((amount || 0) / 100);
      setLoading(false);

      // Realtime balance updates
      const ch = supabase
        .channel("wallet_rt_ui")
        .on(
          "postgres_changes",
          { event: "UPDATE", schema: "public", table: "user_wallets" },
          (payload) => {
            if (payload.new?.user_id === uid) {
              setBalanceCents(payload.new.balance_cents || 0);
            }
          }
        )
        .subscribe();

      await loadTransactions(uid);

      return () => {
        try {
          supabase.removeChannel?.(ch);
        } catch {}
      };
    })();

    async function loadTransactions(uid) {
      setTxError("");
      setTxLoading(true);
      try {
        const { data, error } = await supabase
          .from("wallet_transactions")
          .select("id, type, amount_cents, created_at, description")
          .eq("user_id", uid)
          .order("created_at", { ascending: false })
          .limit(50);
        if (error) throw error;
        setTransactions(data || []);
      } catch (e) {
        setTxError("No transaction history available yet.");
        setTransactions([]);
      } finally {
        setTxLoading(false);
      }
    }
  }, []);

  const balanceDollars = (balanceCents / 100).toFixed(2);

  async function startStripeTopUp({
    userId,
    netTopUpCents,
    clientRef,
    coverFees = true,
    returnTo,
  }) {
    const res = await fetch("/.netlify/functions/create-checkout-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        walletTopUp: true,
        userId,
        netTopUpCents,
        clientRef,
        coverFees,
        successUrl:
          returnTo || window.location.origin + "/app/wallet?success=1",
        cancelUrl:
          returnTo || window.location.origin + "/app/wallet?canceled=1",
      }),
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Stripe session failed: ${txt}`);
    }
    const data = await res.json();
    if (!data?.url) throw new Error("Missing Stripe Checkout URL");
    window.location.href = data.url;
  }

  async function topUpStripe(amountCents) {
    if (!userId) return alert("Please sign in first.");
    try {
      setTopping(true);
      await startStripeTopUp({
        userId,
        netTopUpCents: amountCents,
        clientRef: `${userId}:${Date.now()}`,
        coverFees: true,
        returnTo: window.location.origin,
      });
    } catch (e) {
      console.error(e);
      alert(e.message || "Could not start checkout.");
    } finally {
      setTopping(false);
    }
  }

  function addCustom() {
    setCustomMsg("");
    const n = Number(customUsd);
    if (!Number.isFinite(n)) {
      setCustomMsg("Enter a valid dollar amount.");
      return;
    }
    const cents = Math.round(n * 100);
    if (cents < MIN_CENTS || cents > MAX_CENTS) {
      setCustomMsg("Amount must be between $10 and $500.");
      return;
    }
    topUpStripe(cents);
  }

  async function saveAutoRecharge() {
    const trigger = Math.max(0, Math.round(Number(autoTriggerUsd || 0) * 100));
    const amount = Math.max(0, Math.round(Number(autoAmountUsd || 0) * 100));

    // Update both wallet and subscription if present
    const updates = {
      auto_recharge_threshold_cents: trigger,
      auto_recharge_amount_cents: amount,
    };

    const { error: wErr } = await supabase
      .from("user_wallets")
      .update(updates)
      .eq("user_id", userId);

    const { error: sErr } = await supabase
      .from("subscriptions")
      .update(updates)
      .eq("user_id", userId);

    if (wErr && sErr) {
      setAutoMsg("Failed to save settings.");
    } else {
      setAutoMsg("Auto-recharge settings saved.");
      setTimeout(() => setAutoMsg(""), 3000);
    }
  }

  if (loading) {
    return (
      <div className="min-h-[60vh] grid place-items-center text-white/70">
        <div className="inline-flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading wallet…
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <header className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
        <h1 className="text-lg font-semibold">Wallet</h1>
        <p className="mt-1 text-sm text-white/70">
          Manage your messaging funds and view recent wallet activity.
        </p>
      </header>

      {/* Balance & Add Funds */}
      <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="text-sm text-white/60">Current Balance</div>
            <div className="text-2xl font-semibold">${balanceDollars}</div>
            <div className="mt-1 text-xs text-white/50">
              Texts are billed per segment.
            </div>
          </div>

          <div className="flex flex-col gap-2 md:items-end">
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => topUpStripe(1000)}
                disabled={topping}
                className="inline-flex items-center gap-1 rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm hover:bg-white/10 disabled:opacity-50"
              >
                <CreditCard className="h-4 w-4" /> +$10
              </button>
              <button
                type="button"
                onClick={() => topUpStripe(2000)}
                disabled={topping}
                className="inline-flex items-center gap-1 rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm hover:bg-white/10 disabled:opacity-50"
              >
                <CreditCard className="h-4 w-4" /> +$20
              </button>
              <button
                type="button"
                onClick={() => topUpStripe(5000)}
                disabled={topping}
                className="inline-flex items-center gap-1 rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm hover:bg-white/10 disabled:opacity-50"
              >
                <CreditCard className="h-4 w-4" /> +$50
              </button>
            </div>

            {/* Custom amount */}
            <div className="flex items-center gap-2 mt-2">
              <input
                type="number"
                placeholder="Custom $"
                className="w-24 rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-sm text-white"
                value={customUsd}
                onChange={(e) => setCustomUsd(e.target.value)}
              />
              <button
                type="button"
                onClick={addCustom}
                className="rounded-lg border border-white/15 bg-white/5 px-3 py-1 text-sm hover:bg-white/10"
              >
                <PlusCircle className="h-4 w-4 inline" /> Add
              </button>
            </div>
            {customMsg && (
              <div className="text-xs text-red-400 mt-1">{customMsg}</div>
            )}
          </div>
        </div>
      </section>

      {/* Auto-Recharge Settings */}
<section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 space-y-4">
  <h2 className="text-base font-semibold flex items-center gap-2">
    <RefreshCcw className="h-4 w-4" /> Auto-Recharge
  </h2>
  <p className="text-sm text-white/60">
    Automatically add funds when your wallet balance drops below a certain amount.
  </p>

  <div className="grid gap-3 sm:grid-cols-2">
    <div>
      <label className="block text-xs text-white/60 mb-1">
        Trigger when balance below ($)
      </label>
      <input
        type="number"
        min="0"
        step="1"
        placeholder="e.g. 5"
        value={autoTriggerUsd}
        onChange={(e) => setAutoTriggerUsd(e.target.value)}
        className="w-full rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-white/20"
      />
    </div>

    <div>
      <label className="block text-xs text-white/60 mb-1">
        Recharge amount ($10 minimum)
      </label>
      <input
        type="number"
        min="10"
        step="1"
        placeholder="e.g. 25"
        value={autoAmountUsd}
        onChange={(e) => setAutoAmountUsd(e.target.value)}
        className="w-full rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-white/20"
      />
    </div>
  </div>

  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
    <button
      type="button"
      onClick={saveAutoRecharge}
      className="inline-flex items-center gap-2 rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm hover:bg-white/10"
    >
      <Check className="h-4 w-4" /> Save Settings
    </button>
    {autoMsg && (
      <div className="text-sm text-white/70 flex items-center gap-1">
        <Check className="h-4 w-4 text-green-400" /> {autoMsg}
      </div>
    )}
  </div>
</section>
  );
}
