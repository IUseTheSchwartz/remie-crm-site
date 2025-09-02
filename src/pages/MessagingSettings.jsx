import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { Phone, CreditCard, Check, Loader2 } from "lucide-react";

export default function MessagingSettings() {
  const [loading, setLoading] = useState(true);
  const [numberRow, setNumberRow] = useState(null); // { phone_e164, messaging_service_sid, phone_sid }
  const [balanceCents, setBalanceCents] = useState(0);
  const [areaCode, setAreaCode] = useState("213");
  const [provisioning, setProvisioning] = useState(false);
  const [topping, setTopping] = useState(false);
  const [userId, setUserId] = useState(null);

  const balanceDollars = (balanceCents / 100).toFixed(2);

  useEffect(() => {
    let mounted = true;
    (async () => {
      setLoading(true);
      // who am i?
      const { data: sessionData } = await supabase.auth.getSession();
      const uid = sessionData?.session?.user?.id || null;
      if (!uid) {
        setLoading(false);
        return;
      }
      if (!mounted) return;
      setUserId(uid);

      // load number
      const { data: num } = await supabase
        .from("agent_phone_numbers")
        .select("phone_e164,messaging_service_sid,phone_sid")
        .eq("user_id", uid)
        .maybeSingle();
      if (!mounted) return;
      setNumberRow(num || null);

      // load wallet
      const { data: wallet } = await supabase
        .from("user_wallets")
        .select("balance_cents")
        .eq("user_id", uid)
        .maybeSingle();
      if (!mounted) return;
      setBalanceCents(wallet?.balance_cents || 0);

      setLoading(false);
    })();

    // realtime updates to wallet
    const ch = supabase
      .channel("wallet_rt")
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "user_wallets" },
        (payload) => {
          if (payload.new?.user_id === userId) {
            setBalanceCents(payload.new.balance_cents || 0);
          }
        }
      )
      .subscribe();

    return () => {
      try { supabase.removeChannel?.(ch); } catch {}
      mounted = false;
    };
  }, [userId]);

  async function provisionNumber() {
    if (!userId) return;
    if (!/^\d{3}$/.test(areaCode)) {
      alert("Please enter a valid 3-digit area code.");
      return;
    }
    setProvisioning(true);
    try {
      const res = await fetch("/.netlify/functions/twilio-provision-number", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId, areaCode }),
      });
      if (!res.ok) {
        const m = await res.text();
        throw new Error(m || "Provisioning failed");
      }
      // refresh number row
      const { data: num } = await supabase
        .from("agent_phone_numbers")
        .select("phone_e164,messaging_service_sid,phone_sid")
        .eq("user_id", userId)
        .maybeSingle();
      setNumberRow(num || null);
    } catch (e) {
      console.error(e);
      alert("Could not get a number. Try a different area code.");
    } finally {
      setProvisioning(false);
    }
  }

  async function addFunds(amountCents) {
    setTopping(true);
    try {
      const res = await fetch("/.netlify/functions/create-checkout-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount_cents: amountCents, user_id: userId }),
      });
      const { url } = await res.json();
      if (!url) throw new Error("No checkout URL returned");
      window.location.href = url;
    } catch (e) {
      console.error(e);
      alert("Could not start checkout.");
    } finally {
      setTopping(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-[60vh] grid place-items-center text-white/70">
        <div className="inline-flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading messaging settings…
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
        <h1 className="text-lg font-semibold">Messaging Settings</h1>
        <p className="mt-1 text-sm text-white/70">
          Get a texting number, manage your balance, and configure SMS for clients.
        </p>
      </header>

      {/* Number block */}
      <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-white/5 ring-1 ring-white/10">
              <Phone className="h-5 w-5" />
            </div>
            <div>
              <div className="text-sm text-white/60">Your texting number</div>
              <div className="text-base font-semibold">
                {numberRow?.phone_e164 ? numberRow.phone_e164 : "Not set"}
              </div>
            </div>
          </div>

          {numberRow?.phone_e164 ? (
            <div className="inline-flex items-center gap-1 rounded-lg border border-white/15 bg-white/5 px-2 py-1 text-xs">
              <Check className="h-3.5 w-3.5" /> Active
            </div>
          ) : null}
        </div>

        {!numberRow?.phone_e164 && (
          <div className="mt-4 flex flex-wrap items-end gap-3">
            <div>
              <label className="text-xs text-white/60">Preferred area code</label>
              <input
                value={areaCode}
                onChange={(e) => setAreaCode(e.target.value.replace(/[^\d]/g, "").slice(0, 3))}
                className="mt-1 w-24 rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400/50"
                placeholder="e.g. 213"
              />
            </div>
            <button
              onClick={provisionNumber}
              disabled={provisioning}
              className="rounded-xl border border-white/15 bg-white/5 px-4 py-2 text-sm font-medium hover:bg-white/10 disabled:opacity-50"
            >
              {provisioning ? <Loader2 className="mr-2 inline h-4 w-4 animate-spin" /> : null}
              Get a texting number
            </button>
          </div>
        )}
      </section>

      {/* Wallet block */}
      <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm text-white/60">Text balance</div>
            <div className="text-xl font-semibold">${balanceDollars}</div>
            <div className="mt-1 text-xs text-white/50">
              Texts are billed per segment. Reply STOP to opt out is appended when needed.
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => addFunds(2000)}
              disabled={topping}
              className="inline-flex items-center gap-1 rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm hover:bg-white/10 disabled:opacity-50"
              title="Add $20"
            >
              <CreditCard className="h-4 w-4" /> +$20
            </button>
            <button
              onClick={() => addFunds(5000)}
              disabled={topping}
              className="inline-flex items-center gap-1 rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm hover:bg-white/10 disabled:opacity-50"
              title="Add $50"
            >
              <CreditCard className="h-4 w-4" /> +$50
            </button>
          </div>
        </div>
      </section>

      {/* FYI block */}
      <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
        <h3 className="text-sm font-medium">Compliance</h3>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-white/70">
          <li>Only text clients who have opted in or have an existing relationship.</li>
          <li>First outbound may include: “Msg&data rates may apply. Reply STOP to opt out.”</li>
          <li>Replies like STOP/START/HELP are honored automatically by carriers/Twilio.</li>
        </ul>
      </section>
    </div>
  );
}
