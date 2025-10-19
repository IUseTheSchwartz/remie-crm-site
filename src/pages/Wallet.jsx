// File: src/pages/Wallet.jsx
import { useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { CreditCard, Loader2, Check, PlusCircle, RefreshCcw } from "lucide-react";

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

  const MIN_CENTS = 100;
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

      // Load balance
      const { data: wallet } = await supabase
        .from("user_wallets")
        .select("balance_cents")
        .eq("user_id", uid)
        .maybeSingle();
      if (!mounted) return;
      setBalanceCents(wallet?.balance_cents || 0);
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
        try { supabase.removeChannel?.(ch); } catch {}
      };
    })();

    async function loadTransactions(uid) {
      setTxError("");
      setTxLoading(true);
      try {
        const { data, error } = await supabase
          .from("wallet_transactions") // if you use a different table name, change here
          .select("id, type, amount_cents, created_at, description")
          .eq("user_id", uid)
          .order("created_at", { ascending: false })
          .limit(50);
        if (error) throw error;
        setTransactions(data || []);
      } catch (e) {
        // If the table doesn't exist yet, fail silently with a friendly message
        setTxError("No transaction history available yet.");
        setTransactions([]);
      } finally {
        setTxLoading(false);
      }
    }
  }, []);

  const balanceDollars = (balanceCents / 100).toFixed(2);

  async function startStripeTopUp({ userId, netTopUpCents, clientRef, coverFees = true, returnTo }) {
    const res = await fetch("/.netlify/functions/create-checkout-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        walletTopUp: true,
        userId,
        netTopUpCents,
        clientRef,
        coverFees,
        successUrl: returnTo || window.location.origin + "/app/wallet?success=1",
        cancelUrl: returnTo || window.location.origin + "/app/wallet?canceled=1",
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
      setCustomMsg("Amount must be between $1 and $500.");
      return;
    }
    topUpStripe(cents);
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
        <p className="mt-1 text-sm text-white/70">Manage your messaging funds and view recent wallet activity.</p>
      </header>

      {/* Balance & Add Funds */}
      <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="text-sm text-white/60">Current Balance</div>
            <div className="text-2xl font-semibold">${balanceDollars}</div>
            <div className="mt-1 text-xs text-white/50">Texts are billed per segment.</div>
          </div>

          <div className="flex flex-col gap-2 md:items-end">
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => topUpStripe(500)} disabled={topping} className="inline-flex items-center gap-1 rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm hover:bg-white/10 disabled:opacity-50"><CreditCard className="h-4 w-4" /> +$5</button>
              <button type="button" onClick={() => topUpStripe(1000)} disabled={topping} className="inline-flex items-center gap-1 rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm hover:bg-white/10 disabled:opacity-50"><CreditCard className="h-4 w-4" /> +$10</button>
              <button type="button" onClick={() => topUpStripe(2000)} disabled={topping} className="inline-flex items-center gap-1 rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm hover:bg-white/10 disabled:opacity-50"><CreditCard className="h-4 w-4" /> +$20</button>
              <button type="button" onClick={() => topUpStripe(5000)} disabled={topping} className="inline-flex items-center gap-1 rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm hover:bg-white/10 disabled:opacity-50"><CreditCard className="h-4 w-4" /> +$50</button>
            </div>

            <div className="flex items-center gap-2">
              <label className="text-xs text-white/60">Custom:</label>
              <div className="flex items-center gap-2">
                <div className="relative">
                  <span className="pointer-events-none absolute left-2 top-1.5 text-sm text-white/50">$</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    min="1"
                    max="500"
                    step="1"
                    value={customUsd}
                    onChange={(e) => setCustomUsd(e.target.value)}
                    placeholder="e.g. 7"
                    className="w-24 rounded-lg border border-white/15 bg-white/5 pl-5 pr-3 py-2 text-sm outline-none focus:ring-1 focus:ring-indigo-400/50"
                  />
                </div>
                <button type="button" onClick={addCustom} disabled={topping} className="inline-flex items-center gap-1 rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm hover:bg-white/10 disabled:opacity-50"><PlusCircle className="h-4 w-4" /> Add</button>
              </div>
              {customMsg && <div className="text-xs text-amber-300">{customMsg}</div>}
            </div>

            <div className="text-[11px] text-white/40">Allowed custom range: $1–$500</div>
          </div>
        </div>
      </section>

      {/* Transactions */}
      <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold">Recent Activity</h3>
          <button
            type="button"
            onClick={async () => {
              if (!userId) return;
              try {
                setTxError("");
                setTxLoading(true);
                const { data, error } = await supabase
                  .from("wallet_transactions")
                  .select("id, type, amount_cents, created_at, description")
                  .eq("user_id", userId)
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
            }}
            className="inline-flex items-center gap-1 rounded-md border border-white/15 bg-white/5 px-2 py-1 text-[11px] hover:bg-white/10"
          >
            <RefreshCcw className="h-3.5 w-3.5" /> Refresh
          </button>
        </div>

        {txLoading ? (
          <div className="rounded-lg bg-white/5 p-3 text-sm text-white/70">
            <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
            Loading activity…
          </div>
        ) : txError ? (
          <div className="rounded-lg border border-white/10 bg-black/30 p-3 text-sm text-white/60">
            {txError}
          </div>
        ) : transactions.length === 0 ? (
          <div className="rounded-lg border border-white/10 bg-black/30 p-3 text-sm text-white/60">
            No activity yet.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-white/10">
            <table className="min-w-[640px] w-full border-collapse text-sm">
              <thead className="bg-white/[0.04] text-white/70">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Date</th>
                  <th className="px-3 py-2 text-left font-medium">Type</th>
                  <th className="px-3 py-2 text-left font-medium">Description</th>
                  <th className="px-3 py-2 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {transactions.map((t) => {
                  const sign = t.amount_cents >= 0 ? "+" : "−";
                  const abs = Math.abs(t.amount_cents || 0);
                  const dollars = (abs / 100).toFixed(2);
                  const dt = new Date(t.created_at);
                  const dateStr = dt.toLocaleString();
                  return (
                    <tr key={t.id} className="border-t border-white/10">
                      <td className="px-3 py-2">{dateStr}</td>
                      <td className="px-3 py-2 capitalize">{String(t.type || "").replace(/_/g, " ") || "—"}</td>
                      <td className="px-3 py-2">{t.description || "—"}</td>
                      <td className="px-3 py-2 text-right">
                        <span className={t.amount_cents >= 0 ? "text-emerald-300" : "text-rose-300"}>
                          {sign}${dollars}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
