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

  // Minimum top-up is now $10
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

      // Load wallet balance
      const { data: wallet } = await supabase
        .from("user_wallets")
        .select(
          "balance_cents, auto_recharge_threshold_cents, auto_recharge_amount_cents"
        )
        .eq("user_id", uid)
        .maybeSingle();
      if (!mounted) return;
      setBalanceCents(wallet?.balance_cents || 0);
      if (wallet) {
        setAutoTriggerUsd(
          (wallet.auto_recharge_threshold_cents || 0) / 100 || ""
        );
        setAutoAmountUsd((wallet.auto_recharge_amount_cents || 0) / 100 || "");
      }
      setLoading(false);

      // Realtime updates
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

      // Initial transactions load
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
    const amount = Math.max(MIN_CENTS, Math.round(Number(autoAmountUsd || 0) * 100));

    const { error } = await supabase
      .from("user_wallets")
      .update({
        auto_recharge_threshold_cents: trigger,
        auto_recharge_amount_cents: amount,
      })
      .eq("user_id", userId);

    if (error) {
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

            <div className="flex items-center gap-2">
              <label className="text-xs text-white/60">Custom:</label>
              <div className="flex items-center gap-2">
                <div className="relative">
                  <span className="pointer-events-none absolute left-2 top-1.5 text-sm text-white/50">
                    $
                  </span>
                  <input
                    type="number"
                    inputMode="decimal"
                    min="10"
                    max="500"
                    step="1"
                    value={customUsd}
                    onChange={(e) => setCustomUsd(e.target.value)}
                    placeholder="e.g. 25"
                    className="w-24 rounded-lg bg-white/5 px-4 py-1 text-sm border border-white/15 text-white"
                  />
                </div>
                <button
                  onClick={addCustom}
                  disabled={topping}
                  className="inline-flex items-center gap-1 rounded-lg border border-white/15 bg-white/5 px-2 py-1 text-sm hover:bg-white/10 disabled:opacity-50"
                >
                  <PlusCircle className="h-4 w-4" /> Add
                </button>
              </div>
            </div>

            {customMsg && (
              <p className="text-xs text-red-400 mt-1">{customMsg}</p>
            )}
          </div>
        </div>
      </section>

      {/* Auto-Recharge Settings */}
      <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
        <h2 className="text-base font-semibold mb-2 flex items-center gap-2">
          <RefreshCcw className="h-4 w-4" /> Auto-Recharge
        </h2>
        <p className="text-sm text-white/60 mb-4">
          Automatically add funds when your wallet drops below a chosen amount.
        </p>

        <div className="flex flex-col md:flex-row md:items-end gap-3">
          <div>
            <label className="text-xs text-white/60 block mb-1">
              Trigger Below ($)
            </label>
            <input
              type="number"
              min="5"
              step="1"
              value={autoTriggerUsd}
              onChange={(e) => setAutoTriggerUsd(e.target.value)}
              className="w-32 rounded-lg bg-white/5 px-2 py-1 text-sm border border-white/15 text-white"
              placeholder="e.g. 10"
            />
          </div>

          <div>
            <label className="text-xs text-white/60 block mb-1">
              Recharge Amount ($)
            </label>
            <input
              type="number"
              min="10"
              step="1"
              value={autoAmountUsd}
              onChange={(e) => setAutoAmountUsd(e.target.value)}
              className="w-32 rounded-lg bg-white/5 px-2 py-1 text-sm border border-white/15 text-white"
              placeholder="e.g. 20"
            />
          </div>

          <button
            onClick={saveAutoRecharge}
            className="inline-flex items-center gap-1 rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm hover:bg-white/10 disabled:opacity-50"
          >
            <Check className="h-4 w-4" /> Save
          </button>
        </div>

        {autoMsg && <p className="text-xs text-green-400 mt-2">{autoMsg}</p>}
      </section>

      {/* Transactions */}
      <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
        <h2 className="text-base font-semibold mb-2 flex items-center gap-2">
          <CreditCard className="h-4 w-4" /> Recent Transactions
        </h2>
        {txLoading ? (
          <div className="text-sm text-white/60 flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : txError ? (
          <p className="text-sm text-white/60">{txError}</p>
        ) : transactions.length === 0 ? (
          <p className="text-sm text-white/60">No transactions yet.</p>
        ) : (
          <ul className="text-sm divide-y divide-white/10">
            {transactions.map((tx) => (
              <li key={tx.id} className="py-2 flex justify-between items-center">
                <span className="text-white/80">
                  {tx.description || tx.type}
                </span>
                <span
                  className={
                    tx.amount_cents > 0
                      ? "text-green-400"
                      : "text-red-400"
                  }
                >
                  {tx.amount_cents > 0 ? "+" : "-"}$
                  {(Math.abs(tx.amount_cents) / 100).toFixed(2)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
