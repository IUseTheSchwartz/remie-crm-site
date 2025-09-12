// File: src/pages/MessagesPage.jsx
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../lib/supabaseClient.js";
import { useAuth } from "../auth.jsx";
import { Send, CreditCard, Plus, Loader2, Trash2, Edit3 } from "lucide-react";

/* ---------------- Phone helpers (US/CA default) ---------------- */

/** Normalize arbitrary user input to E.164.
 * - Accepts "+1XXXXXXXXXX" as-is (spaces removed)
 * - Strips non-digits from local formats like "(615) 555-1234"
 * - If 10 digits, prefixes +1
 * - If 11 digits and starts with "1", prefixes +
 * - Returns null if it can't be made E.164 safely
 */
function normalizeToE164_US_CA(input) {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("+")) {
    const compact = trimmed.replace(/\s+/g, "");
    return /^\+\d{10,15}$/.test(compact) ? compact : null;
  }
  const digits = trimmed.replace(/\D+/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/** Pretty local mask for small UI hints (does NOT affect what we send) */
function formatPhoneLocalMask(p) {
  if (!p) return "";
  const d = String(p).replace(/\D+/g, "");
  if (d.length === 11 && d.startsWith("1")) {
    return `1 ${d.slice(1, 4)}-${d.slice(4, 7)}-${d.slice(7, 11)}`;
  }
  if (d.length >= 10) {
    return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6, 10)}`;
  }
  return p;
}

/** Old helper kept for contact-map keys (normalize to 10 digits) */
const normalizeDigits = (s) => {
  const d = String(s || "").replace(/\D/g, "");
  return d.length === 11 && d.startsWith("1") ? d.slice(1) : d.slice(0, 10);
};

function classNames(...xs) {
  return xs.filter(Boolean).join(" ");
}

/* ---------------- Main page ---------------- */

export default function MessagesPage() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);

  // Wallet
  const [balanceCents, setBalanceCents] = useState(0);
  const balanceDollars = useMemo(
    () => (balanceCents / 100).toFixed(2),
    [balanceCents]
  );

  // Threads & conversation
  const [threads, setThreads] = useState([]); // [{partnerNumber, lastMessage, lastAt}]
  const [activeNumber, setActiveNumber] = useState(null); // always E.164
  const [conversation, setConversation] = useState([]); // messages ordered asc

  // Contacts name map
  const [nameMap, setNameMap] = useState({}); // key: normalized 10-digit -> {id, name, rawPhone}

  // Compose
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const scrollerRef = useRef(null);

  /* ---------- Fetchers ---------- */

  async function fetchWallet() {
    if (!user?.id) return;
    const { data, error } = await supabase
      .from("user_wallets")
      .select("balance_cents")
      .eq("user_id", user.id)
      .maybeSingle();
    if (!error && data) setBalanceCents(data.balance_cents || 0);
  }

  async function fetchNameMap() {
    if (!user?.id) return;
    const { data, error } = await supabase
      .from("message_contacts")
      .select("id, phone, full_name")
      .eq("user_id", user.id);
    if (error) return;
    const m = {};
    (data || []).forEach((c) => {
      const key = normalizeDigits(c.phone);
      if (!key) return;
      if (!m[key]) m[key] = { id: c.id, name: c.full_name || "", rawPhone: c.phone };
    });
    setNameMap(m);
  }

  async function fetchThreads() {
    if (!user?.id) return;
    const { data, error } = await supabase
      .from("messages")
      .select(
        "id, direction, to_number, from_number, body, status, created_at"
      )
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) return;

    const grouped = [];
    const seenPartners = new Set();
    for (const m of data) {
      const isOut = m.direction === "out" || m.direction === "outgoing";
      const partner = isOut ? m.to_number : m.from_number;
      if (!partner) continue;

      // normalize partner to E.164 if possible for consistent keys
      const norm = normalizeToE164_US_CA(String(partner)) || String(partner).trim();
      if (seenPartners.has(norm)) continue;
      seenPartners.add(norm);

      grouped.push({
        partnerNumber: norm,
        lastMessage: m.body,
        lastAt: m.created_at,
      });
    }
    setThreads(grouped);

    if (!activeNumber && grouped[0]?.partnerNumber) {
      setActiveNumber(grouped[0].partnerNumber);
    }
  }

  async function fetchConversation(numberE164) {
    if (!user?.id || !numberE164) return;
    const { data, error } = await supabase
      .from("messages")
      .select(
        "id, direction, to_number, from_number, body, status, created_at"
      )
      .eq("user_id", user.id)
      .or(`to_number.eq.${numberE164},from_number.eq.${numberE164}`)
      .order("created_at", { ascending: true })
      .limit(500);
    if (error) return;
    setConversation(data || []);
    queueMicrotask(() => {
      scrollerRef.current?.scrollTo({
        top: scrollerRef.current.scrollHeight,
        behavior: "smooth",
      });
    });
  }

  /* ---------- Mutations: rename & remove ---------- */

  function displayForNumber(numLike) {
    const key = normalizeDigits(numLike);
    const entry = nameMap[key];
    if (entry?.name?.trim()) return entry.name.trim();
    // fallback: show pretty mask
    return formatPhoneLocalMask(numLike);
  }
  function smallPhoneForNumber(numLike) {
    const key = normalizeDigits(numLike);
    const entry = nameMap[key];
    // If we have a name, show phone as secondary; else nothing
    return entry?.name?.trim() ? formatPhoneLocalMask(numLike) : "";
  }

  async function renameConversation(partnerNumberE164) {
    if (!user?.id || !partnerNumberE164) return;
    const current = displayForNumber(partnerNumberE164);
    const proposed = prompt(
      "Name this conversation:",
      current.startsWith("(") || current.startsWith("+") ? "" : current
    );
    if (proposed == null) return; // cancel
    const name = proposed.trim();
    const norm10 = normalizeDigits(partnerNumberE164);

    const existing = nameMap[norm10];

    try {
      if (existing?.id) {
        const { error } = await supabase
          .from("message_contacts")
          .update({ full_name: name || null })
          .eq("id", existing.id);
        if (error) throw error;
      } else {
        // Create a contact row so the name sticks
        const { error } = await supabase.from("message_contacts").insert([{
          user_id: user.id,
          phone: partnerNumberE164,
          full_name: name || null,
          tags: [],
          meta: {},
        }]);
        if (error) throw error;
      }
      await fetchNameMap();
      setThreads((ts) => [...ts]); // re-render
    } catch (e) {
      console.error(e);
      alert("Could not save name.");
    }
  }

  async function removeConversation(partnerNumberE164) {
    if (!user?.id || !partnerNumberE164) return;
    const confirmDelete = confirm(
      `Remove this conversation?\nThis deletes all messages with ${formatPhoneLocalMask(partnerNumberE164)}.`
    );
    if (!confirmDelete) return;
    try {
      const { error } = await supabase
        .from("messages")
        .delete()
        .eq("user_id", user.id)
        .or(`to_number.eq.${partnerNumberE164},from_number.eq.${partnerNumberE164}`);
      if (error) throw error;

      setConversation([]);
      if (activeNumber === partnerNumberE164) setActiveNumber(null);

      await fetchThreads();
    } catch (e) {
      console.error(e);
      alert("Could not remove conversation.");
    }
  }

  /* ---------- Effects ---------- */

  useEffect(() => {
    let mounted = true;
    (async () => {
      setLoading(true);
      await Promise.all([fetchWallet(), fetchNameMap(), fetchThreads()]);
      setLoading(false);
    })();

    // Realtime: listen for new messages for this user
    const channel = supabase
      .channel("messages_rt")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "messages",
          filter: `user_id=eq.${user?.id || ""}`,
        },
        async () => {
          if (!mounted) return;
          await fetchThreads();
          if (activeNumber) await fetchConversation(activeNumber);
        }
      )
      .subscribe();

    return () => {
      mounted = false;
      try {
        supabase.removeChannel(channel);
      } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  useEffect(() => {
    if (activeNumber) fetchConversation(activeNumber);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeNumber]);

  /* ---------- Actions ---------- */

  async function handleSend() {
    if (!text.trim() || !activeNumber) return;
    if (balanceCents <= 0) {
      alert("Your text balance is $0. Add funds to send messages.");
      return;
    }
    setSending(true);
    try {
      const { data: session } = await supabase.auth.getSession();
      const token = session?.session?.access_token;

      // Ensure we always send an E.164 number
      const toE164 = normalizeToE164_US_CA(activeNumber);
      if (!toE164) {
        alert("Invalid phone number format. Please enter a valid US/CA number.");
        setSending(false);
        return;
      }

      const res = await fetch("/.netlify/functions/messages-send", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ to: toE164, body: text }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          out?.telnyx_response?.errors?.[0]?.detail ||
            out?.error ||
            "Send failed"
        );
      }
      setText("");
      scrollerRef.current?.scrollTo({
        top: scrollerRef.current.scrollHeight,
        behavior: "smooth",
      });
      fetchWallet();
      // refresh conversation to show the queued row immediately
      await fetchConversation(toE164);
      // also ensure thread key stays normalized
      setActiveNumber(toE164);
    } catch (e) {
      console.error(e);
      alert("Failed to send message.\n" + (e?.message || ""));
    } finally {
      setSending(false);
    }
  }

  async function startTopUp(amountCents) {
    try {
      const res = await fetch("/.netlify/functions/create-checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount_cents: amountCents, user_id: user.id }),
      });
      const { url } = await res.json();
      if (url) window.location.href = url;
    } catch (e) {
      console.error(e);
      alert("Could not start checkout.");
    }
  }

  /* ---------- UI ---------- */

  if (loading) {
    return (
      <div className="min-h-[60vh] grid place-items-center text-white/70">
        <div className="inline-flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading messages…
        </div>
      </div>
    );
  }

  return (
    <div className="grid h-[calc(100vh-140px)] grid-cols-1 gap-4 md:grid-cols-[320px_1fr]">
      {/* Left: threads (follow-ups panel removed) */}
      <aside className="flex flex-col rounded-2xl border border-white/10 bg-white/[0.03]">
        {/* Wallet */}
        <div className="flex items-center justify-between border-b border-white/10 p-3">
          <div className="text-sm">
            <div className="text-white/60">Text Balance</div>
            <div className="text-lg font-semibold">${balanceDollars}</div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => startTopUp(2000)}
              className="inline-flex items-center gap-1 rounded-lg border border-white/15 bg-white/5 px-2.5 py-1.5 text-xs hover:bg-white/10"
              title="Add $20"
            >
              <CreditCard className="h-4 w-4" /> +$20
            </button>
            <button
              onClick={() => startTopUp(5000)}
              className="inline-flex items-center gap-1 rounded-lg border border-white/15 bg-white/5 px-2.5 py-1.5 text-xs hover:bg-white/10"
              title="Add $50"
            >
              <CreditCard className="h-4 w-4" /> +$50
            </button>
          </div>
        </div>

        {/* Threads header */}
        <div className="flex items-center justify-between px-3 pt-2 text-xs text-white/60">
          <div>Conversations</div>
          <button
            onClick={() => {
              const raw = prompt(
                "Text a new number.\nEnter any format (e.g., 615-555-1234 or +16155551234):"
              );
              if (!raw) return;
              const e164 = normalizeToE164_US_CA(raw);
              if (!e164) {
                alert("Invalid number. Use a valid US/CA number.");
                return;
              }
              setActiveNumber(e164);
            }}
            className="inline-flex items-center gap-1 rounded-md border border-white/15 bg-white/5 px-2 py-1 hover:bg-white/10"
          >
            <Plus className="h-3.5 w-3.5" /> New
          </button>
        </div>

        {/* Threads list */}
        <div className="scrollbar-thin mt-2 flex-1 overflow-y-auto px-2 pb-2">
          {threads.length === 0 ? (
            <div className="p-3 text-xs text-white/50">No conversations yet.</div>
          ) : (
            threads.map((t) => {
              const name = displayForNumber(t.partnerNumber);
              const small = smallPhoneForNumber(t.partnerNumber);
              const isActive = activeNumber === t.partnerNumber;
              return (
                <div
                  key={t.partnerNumber}
                  className={classNames(
                    "group relative w-full rounded-xl p-3 hover:bg-white/5",
                    isActive ? "bg-white/5 ring-1 ring-indigo-400/50" : ""
                  )}
                >
                  <button
                    onClick={() => setActiveNumber(t.partnerNumber)}
                    className="block w-full text-left"
                  >
                    <div className="text-sm font-medium truncate">{name}</div>
                    <div className="truncate text-xs text-white/60">
                      {small || t.lastMessage}
                    </div>
                    {small && (
                      <div className="truncate text-[11px] text-white/40">
                        {t.lastMessage}
                      </div>
                    )}
                  </button>

                  <div className="absolute right-2 top-2 hidden gap-1 group-hover:flex">
                    <button
                      onClick={() => renameConversation(t.partnerNumber)}
                      className="rounded-md border border-white/15 bg-white/5 px-2 py-1 text-[11px] hover:bg-white/10"
                      title="Rename"
                    >
                      <Edit3 className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => removeConversation(t.partnerNumber)}
                      className="rounded-md border border-rose-400/30 bg-rose-500/10 px-2 py-1 text-[11px] text-rose-200 hover:bg-rose-500/20"
                      title="Remove conversation"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </aside>

      {/* Right: conversation */}
      <section className="flex min-h-0 flex-col rounded-2xl border border-white/10 bg-white/[0.03]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/10 p-3">
          <div className="text-sm">
            <div className="text-white/60">Chatting with</div>
            <div className="font-semibold">
              {activeNumber ? displayForNumber(activeNumber) : "—"}
            </div>
            {activeNumber && smallPhoneForNumber(activeNumber) && (
              <div className="text-xs text-white/50">
                {smallPhoneForNumber(activeNumber)}
              </div>
            )}
            {activeNumber && (
              <div className="text-[11px] text-white/40 mt-0.5">
                E.164: <span className="font-mono">{activeNumber}</span>
              </div>
            )}
          </div>
          {activeNumber && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => renameConversation(activeNumber)}
                className="inline-flex items-center gap-1 rounded-md border border-white/15 bg-white/5 px-2 py-1 text-xs hover:bg-white/10"
                title="Rename"
              >
                <Edit3 className="h-3.5 w-3.5" /> Rename
              </button>
              <button
                onClick={() => removeConversation(activeNumber)}
                className="inline-flex items-center gap-1 rounded-md border border-rose-400/30 bg-rose-500/10 px-2 py-1 text-xs text-rose-200 hover:bg-rose-500/20"
                title="Remove conversation"
              >
                <Trash2 className="h-3.5 w-3.5" /> Remove
              </button>
            </div>
          )}
        </div>

        {/* Messages */}
        <div ref={scrollerRef} className="scrollbar-thin flex-1 overflow-y-auto p-4">
          {activeNumber ? (
            conversation.length === 0 ? (
              <div className="grid h-full place-items-center text-sm text-white/50">
                No messages yet.
              </div>
            ) : (
              conversation.map((m) => {
                const isOut = m.direction === "out" || m.direction === "outgoing";
                return (
                  <div
                    key={m.id}
                    className={classNames(
                      "mb-2 flex",
                      isOut ? "justify-end" : "justify-start"
                    )}
                  >
                    <div
                      className={classNames(
                        "max-w-[75%] rounded-2xl px-3 py-2 text-sm ring-1",
                        isOut
                          ? "bg-gradient-to-r from-indigo-500/30 via-purple-500/30 to-fuchsia-500/30 ring-indigo-400/30"
                          : "bg-white/5 ring-white/10"
                      )}
                      title={new Date(m.created_at).toLocaleString()}
                    >
                      <div>{m.body}</div>
                      {isOut && (
                        <div className="mt-1 text-[10px] uppercase tracking-wide text-white/50">
                          {m.status}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })
            )
          ) : (
            <div className="grid h-full place-items-center text-sm text-white/50">
              Select or start a conversation.
            </div>
          )}
        </div>

        {/* Composer */}
        <div className="border-t border-white/10 p-3">
          <div className="flex items-end gap-2">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={activeNumber ? "Type a message…" : "Pick a conversation first"}
              disabled={!activeNumber || sending}
              rows={2}
              className="min-h-[44px] w-full resize-y rounded-xl border border-white/15 bg-white/5 p-2 text-sm placeholder:text-white/40 focus:outline-none focus:ring-1 focus:ring-indigo-400/50"
            />
            <button
              onClick={handleSend}
              disabled={!activeNumber || !text.trim() || sending || balanceCents <= 0}
              className={classNames(
                "inline-flex h-[44px] items-center gap-2 rounded-xl border px-4 font-medium",
                "border-white/15 bg-white/5 hover:bg-white/10",
                (!activeNumber || !text.trim() || sending || balanceCents <= 0) &&
                  "opacity-50 cursor-not-allowed"
              )}
            >
              {sending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
              Send
            </button>
          </div>
          {balanceCents <= 0 && (
            <div className="mt-2 text-xs text-amber-300/90">
              Your balance is $0. Add funds to send messages.
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
