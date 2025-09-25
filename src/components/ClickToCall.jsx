// File: src/components/ClickToCall.jsx
import { useEffect, useMemo, useState } from "react";
import { Phone, Loader2 } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { toE164 } from "../lib/phone";

const FN_BASE = import.meta.env?.VITE_FUNCTIONS_BASE || "/.netlify/functions";

/**
 * Renders a monospace phone link like 1 (615) 555-1234 and makes it tel: clickable.
 */
export function PhoneLink({ number, className = "" }) {
  const pretty = useMemo(() => {
    const d = String(number || "").replace(/\D+/g, "");
    if (d.length === 11 && d.startsWith("1")) {
      return `1 (${d.slice(1,4)}) ${d.slice(4,7)}-${d.slice(7,11)}`;
    }
    if (d.length === 10) {
      return `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6,10)}`;
    }
    return number || "—";
  }, [number]);

  return (
    <a href={`tel:${number}`} className={`font-mono underline-offset-2 hover:underline ${className}`}>
      {pretty}
    </a>
  );
}

/**
 * Click-to-call button used on the Leads table.
 * It ensures:
 *  - agent phone is known (load from agent_profiles if not provided)
 *  - numbers are normalized to E.164 (+1…)
 *  - payload matches call-start.js (user_id, agent_number, lead_number, contact_id)
 */
export default function ClickToCall({
  number,           // lead phone
  contactId,        // optional: for logging
  callerNumber,     // optional agent phone; if missing we load it
  dialSessionKey,   // optional: for local “busy” key per row
  fromView = "leads",
  className = "",
}) {
  const [agentPhone, setAgentPhone] = useState(callerNumber || "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  // keep prop in sync if parent updates
  useEffect(() => { if (callerNumber) setAgentPhone(callerNumber); }, [callerNumber]);

  // load agent phone from agent_profiles once
  useEffect(() => {
    if (agentPhone) return;
    (async () => {
      try {
        const { data: auth } = await supabase.auth.getUser();
        const uid = auth?.user?.id;
        if (!uid) return;
        const { data } = await supabase
          .from("agent_profiles")
          .select("phone")
          .eq("user_id", uid)
          .maybeSingle();
        if (data?.phone) setAgentPhone(data.phone);
      } catch (e) {
        // non-fatal; user will see “add your phone” message below
        console.warn("load agent phone failed", e?.message || e);
      }
    })();
  }, []); // run once

  async function start() {
    setErr("");
    try {
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth?.user?.id;
      if (!uid) {
        setErr("You must be logged in.");
        return;
      }

      const to = toE164(number);
      const fromAgent = toE164(agentPhone);

      if (!fromAgent) { setErr("Add your phone in Dialer first (we call you there)."); return; }
      if (!to)        { setErr("Lead phone is invalid."); return; }

      setBusy(true);

      const res = await fetch(`${FN_BASE}/call-start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // 🔐 matches call-start.js keys exactly
          user_id: uid,
          agent_id: uid,
          agent_number: fromAgent,
          lead_number: to,
          contact_id: contactId || null,

          // Not strictly required, but helps debug in your webhook logs
          source: fromView,
          dial_session_key: dialSessionKey || null,
        }),
      });

      const out = await res.json().catch(() => ({}));
      if (!res.ok || out?.ok === false) {
        const msg = out?.error || out?.message || `Call failed (${res.status})`;
        throw new Error(msg);
      }
      // success: Telnyx calls your phone now; webhook will handle bridging
    } catch (e) {
      setErr(e.message || "Failed to start call");
    } finally {
      setBusy(false);
    }
  }

  const disabled = busy || !agentPhone || !number;

  return (
    <div className={`inline-flex flex-col ${className}`}>
      <button
        onClick={start}
        disabled={disabled}
        className={`inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm text-white
          hover:bg-emerald-500 disabled:opacity-60 disabled:cursor-not-allowed`}
        title={agentPhone ? "Call this lead" : "Add your phone in Dialer first"}
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Phone className="h-4 w-4" />}
        <span>Call</span>
      </button>
      {(!agentPhone || err) && (
        <span className="mt-1 text-[11px] leading-4 text-rose-300">
          {err || "Add your phone in Dialer first (we call you there)."}
        </span>
      )}
    </div>
  );
}
