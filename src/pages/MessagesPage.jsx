// File: src/pages/MessagesPage.jsx
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../lib/supabaseClient.js";
import { useAuth } from "../auth.jsx";
import { Send, CreditCard, Plus, Loader2 } from "lucide-react";

/* ---------------- Upcoming follow-ups (Pipeline) ---------------- */

function fmt(dt) {
  try {
    const d = new Date(dt);
    return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    })}`;
  } catch {
    return "—";
  }
}
function leadLabel(l) {
  return l.phone || l.email || "Lead";
}

function UpcomingFollowUps() {
  const { user } = useAuth();
  const [items, setItems] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user?.id) return;
    let active = true;
    (async () => {
      setLoading(true);
      setError(null);
      const { data, error } = await supabase
        .from("leads")
        .select("id,next_follow_up_at,phone,email") // only existing columns
        .eq("user_id", user.id)
        .not("next_follow_up_at", "is", null)
        .gte("next_follow_up_at", new Date().toISOString())
        .order("next_follow_up_at", { ascending: true })
        .limit(25);
      if (!active) return;
      if (error) setError(error.message);
      else setItems(data || []);
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [user?.id]);

  return (
    <section className="mx-2 mt-2 rounded-2xl border border-white/10 bg-white/[0.03]">
      <div className="border-b border-white/10 px-3 py-2 text-sm font-medium">
        Upcoming follow-ups (Pipeline)
      </div>
      <div className="p-3 text-sm">
        {loading ? (
          <div className="text-white/60">Loading…</div>
        ) : error ? (
          <div className="text-rose-400">Could not load follow-ups. {error}</div>
        ) : items.length === 0 ? (
          <div className="text-white/60">No upcoming follow-ups.</div>
        ) : (
          <ul className="space-y-2">
            {items.map((l) => (
              <li
                key={l.id}
                className="flex items-center justify-between rounded-lg border border-white/10 bg-black/30 px-3 py-2"
              >
                <div className="truncate">{leadLabel(l)}</div>
                <div className="ml-3 shrink-0 text-white/70">
                  {fmt(l.next_follow_up_at)}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/* ---------------- Helpers ---------------- */

function formatPhone(p) {
  if (!p) return "";
  const d = (p + "").replace(/[^\d]/g, "");
  if (d.length === 11 && d.startsWith("1")) {
    return `+1 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  }
  if (d.length === 10) {
    return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  }
  return p;
}

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
  const [threads, setThreads] = useState([]); // [{partnerNumber, lastMessage, unread}]
  const [activeNumber, setActiveNumber] = useState(null);
  const [conversation, setConversation] = useState([]); // messages ordered asc

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

  async function fetchThreads() {
    if (!user?.id) return;
    // Get latest messages (both directions), then group by counterparty number.
    const { data, error } = await supabase
      .from("messages")
      .select(
        "id, direction, to_number, from_number, body, status, created_at"
      )
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) return;

    const seen = new Set();
    theLoop: for (const m of data) {
      const partner = m.direction === "out" ? m.to_number : m.from_number;
      if (!partner) continue;
      if (threads.some((t) => t.partnerNumber === partner)) continue;
    }
    // Rebuild list without duplicates (fast)
    const grouped = [];
    const seenPartners = new Set();
    for (const m of data) {
      const partner = m.direction === "out" ? m.to_number : m.from_number;
      if (!partner || seenPartners.has(partner)) continue;
      seenPartners.add(partner);
      grouped.push({
        partnerNumber: partner,
        lastMessage: m.body,
        lastAt: m.created_at,
      });
    }
    setThreads(grouped);

    // If no active thread, pick the most recent
    if (!activeNumber && grouped[0]?.partnerNumber) {
      setActiveNumber(grouped[0].partnerNumber);
    }
  }

  async function fetchConversation(number) {
    if (!user?.id || !number) return;
    const { data, error } = await supabase
      .from("messages")
      .select(
        "id, direction, to_number, from_number, body, status, created_at"
      )
      .eq("user_id", user.id)
      .or(`to_number.eq.${number},from_number.eq.${number}`)
      .order("created_at", { ascending: true })
      .limit(500);
    if (error) return;
    setConversation(data || []);
    // Scroll to bottom
    queueMicrotask(() => {
      scrollerRef.current?.scrollTo({
        top: scrollerRef.current.scrollHeight,
        behavior: "smooth",
      });
    });
  }

  /* ---------- Effects ---------- */

  useEffect(() => {
    let mounted = true;
    (async () => {
      setLoading(true);
      await Promise.all([fetchWallet(), fetchThreads()]);
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
      const res = await fetch("/.netlify/functions/messages-send", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ to: activeNumber, body: text }),
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(t || "Send failed");
      }
      setText("");
      // optimistic scroll to bottom
      scrollerRef.current?.scrollTo({
        top: scrollerRef.current.scrollHeight,
        behavior: "smooth",
      });
      // wallet may have been debited (reserved) — refresh
      fetchWallet();
    } catch (e) {
      console.error(e);
      alert("Failed to send message.");
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
      {/* Left: threads + follow-ups */}
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

        {/* Follow-ups panel */}
        <UpcomingFollowUps />

        {/* Threads header */}
        <div className="flex items-center justify-between px-3 pt-2 text-xs text-white/60">
          <div>Conversations</div>
          <button
            onClick={() => {
              const v = prompt(
                "Text a new number (E.164, e.g. +15551234567):"
              );
              if (v) setActiveNumber(v.trim());
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
            threads.map((t) => (
              <button
                key={t.partnerNumber}
                onClick={() => setActiveNumber(t.partnerNumber)}
                className={classNames(
                  "w-full rounded-xl p-3 text-left hover:bg-white/5",
                  activeNumber === t.partnerNumber
                    ? "bg-white/5 ring-1 ring-indigo-400/50"
                    : ""
                )}
              >
                <div className="text-sm font-medium">
                  {formatPhone(t.partnerNumber)}
                </div>
                <div className="truncate text-xs text-white/60">
                  {t.lastMessage}
                </div>
              </button>
            ))
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
              {activeNumber ? formatPhone(activeNumber) : "—"}
            </div>
          </div>
        </div>

        {/* Messages */}
        <div ref={scrollerRef} className="scrollbar-thin flex-1 overflow-y-auto p-4">
          {activeNumber ? (
            conversation.length === 0 ? (
              <div className="grid h-full place-items-center text-sm text-white/50">
                No messages yet.
              </div>
            ) : (
              conversation.map((m) => (
                <div
                  key={m.id}
                  className={classNames(
                    "mb-2 flex",
                    m.direction === "out" ? "justify-end" : "justify-start"
                  )}
                >
                  <div
                    className={classNames(
                      "max-w-[75%] rounded-2xl px-3 py-2 text-sm ring-1",
                      m.direction === "out"
                        ? "bg-gradient-to-r from-indigo-500/30 via-purple-500/30 to-fuchsia-500/30 ring-indigo-400/30"
                        : "bg-white/5 ring-white/10"
                    )}
                    title={new Date(m.created_at).toLocaleString()}
                  >
                    <div>{m.body}</div>
                    {m.direction === "out" && (
                      <div className="mt-1 text-[10px] uppercase tracking-wide text-white/50">
                        {m.status}
                      </div>
                    )}
                  </div>
                </div>
              ))
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
