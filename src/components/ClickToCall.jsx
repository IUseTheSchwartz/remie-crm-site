// File: src/components/ClickToCall.jsx
import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient.js";
import { toE164 } from "../lib/phone.js";
import { startCall } from "../lib/calls.js";

/* Share a couple of localStorage keys as a soft fallback */
const LOCAL_KEYS = ["dialer_my_phone", "my_phone", "remie.myPhone"];
const getLS = () => {
  try {
    for (const k of LOCAL_KEYS) {
      const v = localStorage.getItem(k);
      if (v && v.trim()) return v.trim();
    }
  } catch {}
  return "";
};
const setLS = (val) => {
  try {
    for (const k of LOCAL_KEYS) localStorage.setItem(k, val || "");
  } catch {}
};

/** A tiny tel: link for displaying the number inline (optional) */
export function PhoneLink({ number, className }) {
  const n = String(number || "");
  if (!n) return null;
  const href = "tel:" + n.replace(/[^\d+]/g, "");
  return (
    <a href={href} className={className} title="Call using device dialer">
      {n}
    </a>
  );
}

/** Click-to-call button that pulls the agent phone from agent_profiles.phone */
export default function ClickToCall({ number, contactId, className }) {
  const [busy, setBusy] = useState(false);
  const [myPhone, setMyPhone] = useState("");

  // 1) Load agent phone from agent_profiles on mount
  useEffect(() => {
    (async () => {
      try {
        const { data: auth } = await supabase.auth.getUser();
        const uid = auth?.user?.id;
        if (!uid) return;

        const { data: row } = await supabase
          .from("agent_profiles")
          .select("phone")
          .eq("user_id", uid)
          .maybeSingle();

        const p = row?.phone || getLS() || "";
        if (p) {
          setMyPhone(p);
          setLS(p); // keep LS in sync for other pages/components
        }
      } catch {
        // ignore — we’ll still fall back to LS or prompt on click
      }
    })();
  }, []);

  // Save/Upsert agent phone back to agent_profiles for future
  async function persistAgentPhone(e164) {
    try {
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth?.user?.id;
      if (!uid) return;

      // try update first
      const { data: updated, error: upErr } = await supabase
        .from("agent_profiles")
        .update({ phone: e164 })
        .eq("user_id", uid)
        .select("user_id");

      if (upErr) throw upErr;

      // if no row existed, insert
      if (!updated || updated.length === 0) {
        const { error: insErr } = await supabase
          .from("agent_profiles")
          .insert({ user_id: uid, phone: e164 });
        if (insErr) throw insErr;
      }
    } catch {
      // if this fails we still proceed with the call; it just won't save
    }
  }

  async function onClick() {
    const lead = toE164(String(number || "").trim());
    if (!lead) {
      alert("This lead’s phone number isn’t valid.");
      return;
    }

    // Prefer agent_profiles.phone; if missing, prompt once and save
    let mine = toE164(myPhone || getLS());
    if (!mine) {
      const entered = prompt(
        "Enter the phone number we should call you at first (your cell):",
        ""
      );
      const n = toE164(entered || "");
      if (!n) {
        alert("That didn’t look like a valid number.");
        return;
      }
      mine = n;
      setMyPhone(n);
      setLS(n);
      // attempt to persist in agent_profiles for next time
      persistAgentPhone(n);
    }

    setBusy(true);
    try {
      await startCall({
        agentNumber: mine,
        leadNumber: lead,
        contactId: contactId || null,
      });
      // success → nothing else to do (webhook will create a call_log row)
    } catch (e) {
      alert(e?.message || "Couldn’t start the call.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      onClick={onClick}
      disabled={busy}
      className={`inline-flex items-center rounded-md border border-white/15 bg-white/5 px-2 py-1 text-xs hover:bg-white/10 ${className || ""}`}
      title="Click to call (we'll ring your phone first)"
    >
      {busy ? "Calling…" : "Call"}
    </button>
  );
}
