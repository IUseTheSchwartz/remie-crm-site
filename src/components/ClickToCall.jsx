// File: src/components/ClickToCall.jsx
import { useCallback, useEffect, useRef, useState } from "react";
import { Phone, Loader2 } from "lucide-react";
import { supabase } from "../lib/supabaseClient.js";
import { listMyNumbers } from "../lib/numbers.js";
import { startCall } from "../lib/calls.js";

/** Match DialerPage's normalization */
function normUS(s) {
  const d = String(s || "").replace(/\D+/g, "");
  if (/^1\d{10}$/.test(d)) return `+${d}`;
  if (/^\d{10}$/.test(d)) return `+1${d}`;
  return s || "";
}

export default function ClickToCall({ toNumber, className }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [hasNumber, setHasNumber] = useState(false);
  const [agentCell, setAgentCell] = useState("");
  const lastLoadedPhoneRef = useRef("");

  // Load agent phone & check ownership like DialerPage does
  useEffect(() => {
    (async () => {
      try {
        // agent phone
        const { data: auth } = await supabase.auth.getUser();
        const uid = auth?.user?.id;
        if (!uid) return;

        const { data: row } = await supabase
          .from("agent_profiles")
          .select("phone")
          .eq("user_id", uid)
          .maybeSingle();

        const phone = row?.phone || "";
        lastLoadedPhoneRef.current = phone;
        setAgentCell(phone);

        // numbers owned
        const mine = await listMyNumbers();
        setHasNumber((mine?.length || 0) > 0);
      } catch (e) {
        // non-fatal; we'll surface specific errors on click
        console.warn("ClickToCall init warning:", e);
      }
    })();
  }, []);

  const onClick = useCallback(async () => {
    setErr("");
    if (!agentCell) { setErr("Add your phone in Dialer first (we call you there)."); return; }
    if (!toNumber) { setErr("Missing lead number."); return; }
    if (!hasNumber) { setErr("You don’t own any numbers yet. Buy one in the Dialer."); return; }

    setBusy(true);
    try {
      await startCall({
        agentNumber: normUS(agentCell),
        leadNumber: normUS(toNumber),
      });
      // Optional: you could fire a toast here or refresh a small local log if you want.
    } catch (e) {
      setErr(e?.message || "Failed to start call");
    } finally {
      setBusy(false);
    }
  }, [agentCell, toNumber, hasNumber]);

  return (
    <div className={className || ""}>
      <button
        onClick={onClick}
        disabled={busy}
        className="inline-flex items-center gap-2 rounded-xl px-3 py-2 bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-60"
        title="Call"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Phone size={16} />}
        <span>Call</span>
      </button>
      {err ? <div className="mt-1 text-xs text-rose-500">{err}</div> : null}
    </div>
  );
}

/** Compatibility wrapper you already use on LeadsPage */
export function PhoneLink({ number }) {
  return <ClickToCall toNumber={number} />;
}
