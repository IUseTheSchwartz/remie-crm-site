import { useEffect, useState } from "react";
import { Phone, Loader2 } from "lucide-react";
import { startCall } from "../lib/calls";
import { getMyBalanceCents } from "../lib/wallet";
import { supabase } from "../lib/supabaseClient";

// Normalize US numbers to +1XXXXXXXXXX if possible
function normUS(s) {
  const d = String(s || "").replace(/\D+/g, "");
  if (/^1\d{10}$/.test(d)) return `+${d}`;
  if (/^\d{10}$/.test(d)) return `+1${d}`;
  return s || "";
}

/**
 * Internal hook: load agent's phone from agent_profiles once.
 */
function useAgentPhone() {
  const [agentPhone, setAgentPhone] = useState("");
  useEffect(() => {
    (async () => {
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth?.user?.id;
      if (!uid) return;
      const { data: row } = await supabase
        .from("agent_profiles")
        .select("phone")
        .eq("user_id", uid)
        .maybeSingle();
      setAgentPhone(row?.phone || "");
    })();
  }, []);
  return [agentPhone, setAgentPhone];
}

/**
 * Core call action shared by both UI variants.
 */
async function placeCall({ agentPhone, leadNumber, contactId }) {
  if (!agentPhone) {
    alert("Add your phone on the Dialer page first.");
    throw new Error("missing agent phone");
  }
  const balance = await getMyBalanceCents().catch(() => 0);
  if ((balance || 0) < 1) {
    alert("You need at least $0.01 in your wallet to place a call.");
    throw new Error("insufficient funds");
  }
  const agent = normUS(agentPhone);
  const lead = normUS(leadNumber);
  if (!lead) {
    alert("Lead has no valid phone number.");
    throw new Error("invalid lead phone");
  }
  return startCall({ agentNumber: agent, leadNumber: lead, contactId });
}

/**
 * Inline clickable phone text: looks like a link, calls on click.
 */
export function PhoneLink({ number, contactId = null, className = "", children, onStarted }) {
  const [agentPhone] = useAgentPhone();
  const [busy, setBusy] = useState(false);

  const handle = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await placeCall({ agentPhone, leadNumber: number, contactId });
      onStarted?.();
      // Optional: you can trigger a toast here
      // setTimeout to allow webhook to log:
      // setTimeout(() => onStarted?.(), 4000);
    } catch (e) {
      // errors already alerted above
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={handle}
      className={[
        "inline-flex items-center gap-1 underline underline-offset-2 hover:opacity-90",
        "disabled:opacity-60 disabled:cursor-not-allowed",
        className,
      ].join(" ")}
      disabled={busy}
      title="Click to call"
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
      <span>{children || number}</span>
    </button>
  );
}

/**
 * Small rounded icon button. Good to place next to a phone number cell.
 */
export default function ClickToCall({ number, contactId = null, size = "sm", className = "", onStarted }) {
  const [agentPhone] = useAgentPhone();
  const [busy, setBusy] = useState(false);

  const sizes = {
    xs: "h-7 w-7",
    sm: "h-8 w-8",
    md: "h-9 w-9",
  };

  const handle = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await placeCall({ agentPhone, leadNumber: number, contactId });
      onStarted?.();
    } catch (e) {
      // errors already alerted above
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={handle}
      disabled={busy}
      className={[
        "inline-grid place-items-center rounded-full border border-white/15 bg-white/10",
        "hover:bg-white/15 transition disabled:opacity-60 disabled:cursor-not-allowed",
        sizes[size] || sizes.sm,
        className,
      ].join(" ")}
      title="Call"
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Phone className="h-4 w-4" />}
    </button>
  );
}
