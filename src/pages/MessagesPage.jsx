import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../lib/supabaseClient.js";
import { useAuth } from "../auth.jsx";
import {
  Send, CreditCard, Plus, Loader2, Trash2, Edit3, X, ChevronLeft, Search
} from "lucide-react";

/* ---------------- Phone helpers (US/CA default) ---------------- */

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

const normalizeDigits10 = (s) => {
  const d = String(s || "").replace(/\D/g, "");
  return d.length === 11 && d.startsWith("1") ? d.slice(1) : d.slice(0, 10);
};

function classNames(...xs) {
  return xs.filter(Boolean).join(" ");
}

/* ---------------- PayPal SDK loader ---------------- */

const PAYPAL_CLIENT_ID = import.meta.env.VITE_PAYPAL_CLIENT_ID;

async function loadPayPalSdk() {
  if (window.paypal) return;
  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(
      PAYPAL_CLIENT_ID || ""
    )}&currency=USD&intent=capture`;
    s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error("Failed to load PayPal SDK"));
    document.head.appendChild(s);
  });
}

/* ---------------- Utility ---------------- */

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const apply = () => setIsMobile(mq.matches);
    apply();
    mq.addEventListener?.("change", apply);
    return () => mq.removeEventListener?.("change", apply);
  }, []);
  return isMobile;
}

/* ---------------- Main page ---------------- */

export default function MessagesPage() {
  const { user } = useAuth();
  const isMobile = useIsMobile();

  const [loading, setLoading] = useState(true);

  // Wallet
  const [balanceCents, setBalanceCents] = useState(0);
  const balanceDollars = useMemo(
    () => (balanceCents / 100).toFixed(2),
    [balanceCents]
  );

  // Threads & conversation
  const [threads, setThreads] = useState([]);
  const [activeNumber, setActiveNumber] = useState(null); // E.164
  const [conversation, setConversation] = useState([]);

  // Contacts name map
  const [nameMap, setNameMap] = useState({}); // key: 10-digit -> {id, name, rawPhone}

  // Compose
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const scrollerRef = useRef(null);

  // PayPal modal
  const [paypalOpen, setPaypalOpen] = useState(false);
  const [paypalAmountCents, setPaypalAmountCents] = useState(0);
  const [paypalLoading, setPaypalLoading] = useState(false);
  const paypalContainerRef = useRef(null);

  /* ---------- Fetchers ---------- */

  async function fetchWallet() {
    if (!user?.id) return;
    const { data } = await supabase
      .from("user_wallets")
      .select("balance_cents")
      .eq("user_id", user.id)
      .maybeSingle();
    if (data) setBalanceCents(data.balance_cents || 0);
  }

  async function fetchNameMap() {
    if (!user?.id) return;
    const { data } = await supabase
      .from("message_contacts")
      .select("id, phone, full_name")
      .eq("user_id", user.id);
    const m = {};
    (data || []).forEach((c) => {
      const key = normalizeDigits10(c.phone);
      if (!key) return;
      if (!m[key]) m[key] = { id: c.id, name: c.full_name || "", rawPhone: c.phone };
    });
    setNameMap(m);
  }

  async function fetchThreads() {
    if (!user?.id) return;
    const { data } = await supabase
      .from("messages")
      .select("id, direction, to_number, from_number, body, status, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(200);

    const grouped = [];
    const seen = new Set();
    for (const m of data || []) {
      const isOut = m.direction === "out" || m.direction === "outgoing";
      const partnerRaw = isOut ? m.to_number : m.from_number;
      if (!partnerRaw) continue;
      const partner = normalizeToE164_US_CA(String(partnerRaw)) || String(partnerRaw).trim();
      if (seen.has(partner)) continue;
      seen.add(partner);
      grouped.push({
        partnerNumber: partner,
        lastMessage: m.body,
        lastAt: m.created_at,
      });
    }
    setThreads(grouped);
    if (!activeNumber && grouped[0]?.partnerNumber) setActiveNumber(grouped[0].partnerNumber);
  }

  async function fetchConversation(numberE164) {
    if (!user?.id || !numberE164) return;
    const { data } = await supabase
      .from("messages")
      .select("id, direction, to_number, from_number, body, status, created_at")
      .eq("user_id", user.id)
      .or(`to_number.eq.${numberE164},from_number.eq.${numberE164}`)
      .order("created_at", { ascending: true })
      .limit(500);
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
    const key = normalizeDigits10(numLike);
    const entry = nameMap[key];
    if (entry?.name?.trim()) return entry.name.trim();
    return formatPhoneLocalMask(numLike);
  }
  function smallPhoneForNumber(numLike) {
    const key = normalizeDigits10(numLike);
    const entry = nameMap[key];
    return entry?.name?.trim() ? formatPhoneLocalMask(numLike) : "";
  }

  async function renameConversation(partnerNumberE164) {
    if (!user?.id || !partnerNumberE164) return;
    const current = displayForNumber(partnerNumberE164);
    const proposed = prompt(
      "Name this conversation:",
      current.startsWith("(") || current.startsWith("+") ? "" : current
    );
    if (proposed == null) return;
    const name = proposed.trim();
    const norm10 = normalizeDigits10(partnerNumberE164);
    const existing = nameMap[norm10];

    try {
      if (existing?.id) {
        await supabase.from("message_contacts").update({ full_name: name || null }).eq("id", existing.id);
      } else {
        await supabase.from("message_contacts").insert([{
          user_id: user.id,
          phone: partnerNumberE164,
          full_name: name || null,
          tags: [],
          meta: {},
        }]);
      }
      await fetchNameMap();
      setThreads((ts) => [...ts]);
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
      const digits = partnerNumberE164.replace(/\D/g, "");
      const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits.slice(0, 10);
      const variants = new Set([ partnerNumberE164, ten, "1"+ten, "+1"+ten ]);

      const { data: toRows } = await supabase
        .from("messages").select("id")
        .eq("user_id", user.id).in("to_number", Array.from(variants));
      const { data: fromRows } = await supabase
        .from("messages").select("id")
        .eq("user_id", user.id).in("from_number", Array.from(variants));

      const ids = [
        ...(toRows || []).map(r => r.id),
        ...(fromRows || []).map(r => r.id),
      ];
      const idSet = Array.from(new Set(ids));
      if (idSet.length > 0) {
        const { error: delErr } = await supabase.from("messages").delete().in("id", idSet);
        if (delErr) throw delErr;
      }

      setConversation([]);
      if (activeNumber === partnerNumberE164) setActiveNumber(null);
      await fetchThreads();
    } catch (e) {
      console.error(e);
      alert("Could not remove conversation.");
    }
  }

  /* ---------- PayPal Top-up ---------- */

  async function openPayPal(amountCents) {
    if (!user?.id) return alert("Please sign in first.");
    try {
      setPaypalAmountCents(amountCents);
      setPaypalOpen(true);
      setPaypalLoading(true);

      await loadPayPalSdk();

      if (paypalContainerRef.current) {
        paypalContainerRef.current.innerHTML = "";
      }

      window.paypal
        .Buttons({
          style: { layout: "vertical", shape: "rect", label: "paypal" },
          createOrder: async () => {
            const res = await fetch("/.netlify/functions/paypal-create-order", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ amount_cents: amountCents, user_id: user.id }),
            });
            const data = await res.json();
            if (!data?.id) throw new Error("Failed to create PayPal order");
            return data.id;
          },
          onApprove: async () => {
            setPaypalOpen(false);
            setTimeout(fetchWallet, 2500);
            alert("Payment approved. Your wallet will update shortly.");
          },
          onCancel: () => setPaypalOpen(false),
          onError: (err) => {
            console.error(err);
            setPaypalOpen(false);
            alert("PayPal error. Please try again.");
          },
        })
        .render(paypalContainerRef.current);
    } catch (e) {
      console.error(e);
      setPaypalOpen(false);
      alert(e.message || "Could not start PayPal checkout.");
    } finally {
      setPaypalLoading(false);
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

    const channel = supabase
      .channel("messages_rt")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "messages", filter: `user_id=eq.${user?.id || ""}` },
        async () => {
          if (!mounted) return;
          await fetchThreads();
          if (activeNumber) await fetchConversation(activeNumber);
        }
      )
      .subscribe();

    return () => {
      mounted = false;
      try { supabase.removeChannel(channel); } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  useEffect(() => {
    if (activeNumber) fetchConversation(activeNumber);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeNumber]);

  useEffect(() => {
    if (!scrollerRef.current) return;
    scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
  }, [conversation.length]);

  // Keyboard-aware padding for iOS
  useEffect(() => {
    const el = document.getElementById("chat-scroll");
    const vv = window.visualViewport;
    if (!el || !vv) return;

    let raf = 0;
    const onResize = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const overlap = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
        el.style.paddingBottom = `${overlap + 80}px`;
        el.scrollTop = el.scrollHeight;
      });
    };
    vv.addEventListener("resize", onResize);
    vv.addEventListener("scroll", onResize);
    onResize();
    return () => {
      cancelAnimationFrame(raf);
      vv.removeEventListener("resize", onResize);
      vv.removeEventListener("scroll", onResize);
    };
  }, []);

  /* ---------- Send ---------- */

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
      const toE164 = normalizeToE164_US_CA(activeNumber);
      if (!toE164) {
        alert("Invalid phone number format. Please enter a valid US/CA number.");
        setSending(false);
        return;
      }

      const res = await fetch("/.netlify/functions/messages-send", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ to: toE164, body: text, requesterId: user?.id }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok || out?.error) {
        throw new Error(out?.telnyx_response?.errors?.[0]?.detail || out?.error || "Send failed");
      }
      setText("");
      scrollerRef.current?.scrollTo({ top: scrollerRef.current.scrollHeight, behavior: "smooth" });
      fetchWallet();
      await fetchConversation(toE164);
      setActiveNumber(toE164);
    } catch (e) {
      console.error(e);
      alert("Failed to send message.\n" + (e?.message || ""));
    } finally {
      setSending(false);
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
    <div className="h-[100dvh]">
      {/* --- MOBILE: iOS-style two-screen nav --- */}
      <div className="md:hidden h-full">
        {!activeNumber ? (
          <MobileThreads
            threads={threads}
            balanceDollars={balanceDollars}
            onNew={() => {
              const raw = prompt("Text a new number.\nEnter any format (e.g., 915-494-3286 or +19154943286):");
              if (!raw) return;
              const e164 = normalizeToE164_US_CA(raw);
              if (!e164) return alert("Invalid number. Use a valid US/CA number.");
              setActiveNumber(e164);
            }}
            onOpen={(n) => setActiveNumber(n)}
            displayForNumber={displayForNumber}
            smallPhoneForNumber={smallPhoneForNumber}
            openPayPal={(cents) => openPayPal(cents)}
          />
        ) : (
          <MobileChat
            activeNumber={activeNumber}
            conversation={conversation}
            scrollerRef={scrollerRef}
            displayForNumber={displayForNumber}
            smallPhoneForNumber={smallPhoneForNumber}
            text={text}
            setText={setText}
            sending={sending}
            balanceCents={balanceCents}
            onBack={() => setActiveNumber(null)}
            onRename={() => renameConversation(activeNumber)}
            onRemove={() => removeConversation(activeNumber)}
            onSend={handleSend}
          />
        )}
      </div>

      {/* --- DESKTOP: keep your existing two-panel layout --- */}
      <div className="hidden md:grid h-full grid-cols-[320px_1fr] gap-4">
        {/* Left: threads */}
        <aside className="flex flex-col rounded-2xl border border-white/10 bg-white/[0.03]">
          {/* Wallet */}
          <div className="flex items-center justify-between border-b border-white/10 p-3">
            <div className="text-sm">
              <div className="text-white/60">Text Balance</div>
              <div className="text-lg font-semibold">${balanceDollars}</div>
            </div>
            <div className="flex gap-2">
              <button onClick={() => openPayPal(2000)} className="inline-flex items-center gap-1 rounded-lg border border-white/15 bg-white/5 px-2.5 py-1.5 text-xs hover:bg-white/10" title="Add $20">
                <CreditCard className="h-4 w-4" /> +$20
              </button>
              <button onClick={() => openPayPal(5000)} className="inline-flex items-center gap-1 rounded-lg border border-white/15 bg-white/5 px-2.5 py-1.5 text-xs hover:bg-white/10" title="Add $50">
                <CreditCard className="h-4 w-4" /> +$50
              </button>
            </div>
          </div>

          {/* Threads header */}
          <div className="flex items-center justify-between px-3 pt-2 text-xs text-white/60">
            <div>Conversations</div>
            <button
              onClick={() => {
                const raw = prompt("Text a new number.\nEnter any format (e.g., 915-494-3286 or +19154943286):");
                if (!raw) return;
                const e164 = normalizeToE164_US_CA(raw);
                if (!e164) return alert("Invalid number. Use a valid US/CA number.");
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
                    <button onClick={() => setActiveNumber(t.partnerNumber)} className="block w-full text-left">
                      <div className="text-sm font-medium truncate">{name}</div>
                      <div className="truncate text-xs text-white/60">{small || t.lastMessage}</div>
                      {small && <div className="truncate text-[11px] text-white/40">{t.lastMessage}</div>}
                    </button>
                    <div className="absolute right-2 top-2 hidden gap-1 group-hover:flex">
                      <button onClick={() => renameConversation(t.partnerNumber)} className="rounded-md border border-white/15 bg-white/5 px-2 py-1 text-[11px] hover:bg-white/10" title="Rename">
                        <Edit3 className="h-3.5 w-3.5" />
                      </button>
                      <button onClick={() => removeConversation(t.partnerNumber)} className="rounded-md border border-rose-400/30 bg-rose-500/10 px-2 py-1 text-[11px] text-rose-200 hover:bg-rose-500/20" title="Remove conversation">
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
              <div className="font-semibold">{activeNumber ? displayForNumber(activeNumber) : "—"}</div>
              {activeNumber && smallPhoneForNumber(activeNumber) && (
                <div className="text-xs text-white/50">{smallPhoneForNumber(activeNumber)}</div>
              )}
              {activeNumber && (
                <div className="text-[11px] text-white/40 mt-0.5">
                  E.164: <span className="font-mono">{activeNumber}</span>
                </div>
              )}
            </div>
            {activeNumber && (
              <div className="flex items-center gap-2">
                <button onClick={() => renameConversation(activeNumber)} className="inline-flex items-center gap-1 rounded-md border border-white/15 bg-white/5 px-2 py-1 text-xs hover:bg-white/10" title="Rename">
                  <Edit3 className="h-3.5 w-3.5" /> Rename
                </button>
                <button onClick={() => removeConversation(activeNumber)} className="inline-flex items-center gap-1 rounded-md border border-rose-400/30 bg-rose-500/10 px-2 py-1 text-xs text-rose-200 hover:bg-rose-500/20" title="Remove">
                  <Trash2 className="h-3.5 w-3.5" /> Remove
                </button>
              </div>
            )}
          </div>

          {/* Messages */}
          <div ref={scrollerRef} id="chat-scroll" className="scrollbar-thin flex-1 overflow-y-auto px-3 py-2 space-y-2">
            {activeNumber ? (
              conversation.length === 0 ? (
                <div className="grid h-full place-items-center text-sm text-white/50">No messages yet.</div>
              ) : (
                conversation.map((m) => {
                  const isOut = m.direction === "out" || m.direction === "outgoing";
                  return (
                    <div key={m.id} className={classNames("mb-2 flex", isOut ? "justify-end" : "justify-start")}>
                      <div
                        className={classNames(
                          "max-w-[82%] rounded-2xl px-3 py-2 text-sm leading-snug ring-1 break-words [overflow-wrap:anywhere]",
                          isOut
                            ? "bg-gradient-to-r from-indigo-500/30 via-purple-500/30 to-fuchsia-500/30 ring-indigo-400/30"
                            : "bg-white/5 ring-white/10"
                        )}
                        title={new Date(m.created_at).toLocaleString()}
                      >
                        <div>{m.body}</div>
                        {isOut && (
                          <div className="mt-1 text-[10px] uppercase tracking-wide text-white/50">{m.status}</div>
                        )}
                      </div>
                    </div>
                  );
                })
              )
            ) : (
              <div className="grid h-full place-items-center text-sm text-white/50">Select or start a conversation.</div>
            )}
          </div>

          {/* Composer */}
          <div className="border-t border-white/10 px-3 pt-3 pb-[calc(env(safe-area-inset-bottom)+10px)]">
            <div className="flex items-end gap-2">
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={activeNumber ? "Type a message…" : "Pick a conversation first"}
                disabled={!activeNumber || sending}
                rows={1}
                className="min-h[44px] w-full resize-none rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-base leading-tight placeholder:text-white/40 focus:outline-none focus:ring-1 focus:ring-indigo-400/50 max-h-40"
              />
              <button
                onClick={handleSend}
                disabled={!activeNumber || !text.trim() || sending || balanceCents <= 0}
                className={classNames(
                  "inline-flex h-[44px] items-center gap-2 rounded-xl border px-4 font-medium",
                  "border-white/15 bg-white/5 hover:bg-white/10",
                  (!activeNumber || !text.trim() || sending || balanceCents <= 0) && "opacity-50 cursor-not-allowed"
                )}
              >
                {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                Send
              </button>
            </div>
            {balanceCents <= 0 && (
              <div className="mt-2 text-xs text-amber-300/90">Your balance is $0. Add funds to send messages.</div>
            )}
          </div>
        </section>
      </div>

      {/* --- PayPal Modal (global) --- */}
      {paypalOpen && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-2xl border border-white/10 bg-[#0b0b12] p-4 shadow-2xl">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold">
                Add funds — ${ (paypalAmountCents/100).toFixed(2) }
              </h3>
              <button
                onClick={() => setPaypalOpen(false)}
                className="rounded-md border border-white/15 bg-white/5 p-1 hover:bg-white/10"
                title="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="py-2">
              {paypalLoading && (
                <div className="mb-2 inline-flex items-center gap-2 text-xs text-white/70">
                  <Loader2 className="h-3 w-3 animate-spin" /> Loading PayPal…
                </div>
              )}
              <div ref={paypalContainerRef} />
            </div>

            <p className="mt-2 text-[11px] text-white/50">
              After approval, your wallet updates automatically within a few seconds.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- Mobile components ---------------- */

function MobileThreads({
  threads,
  balanceDollars,
  onNew,
  onOpen,
  displayForNumber,
  smallPhoneForNumber,
  openPayPal,
}) {
  return (
    <div className="h-full flex flex-col bg-white/[0.02]">
      {/* Header */}
      <div className="px-4 pt-[12px] pb-2 border-b border-white/10">
        <div className="text-lg font-semibold">Messages</div>
        <div className="mt-1 flex items-center justify-between">
          <div className="text-sm">
            <span className="text-white/60">Text Balance</span>{" "}
            <span className="font-semibold">${balanceDollars}</span>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => openPayPal(2000)}
              className="inline-flex items-center gap-1 rounded-md border border-white/15 bg-white/5 px-2 py-1 text-xs hover:bg-white/10"
              title="Add $20"
            >
              <CreditCard className="h-3.5 w-3.5" /> +$20
            </button>
            <button
              onClick={() => openPayPal(5000)}
              className="inline-flex items-center gap-1 rounded-md border border-white/15 bg-white/5 px-2 py-1 text-xs hover:bg-white/10"
              title="Add $50"
            >
              <CreditCard className="h-3.5 w-3.5" /> +$50
            </button>
          </div>
        </div>

        <div className="mt-2 flex items-center gap-2">
          <div className="flex-1 relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-white/40" />
            <input
              placeholder="Search"
              className="w-full rounded-lg border border-white/15 bg-white/5 pl-8 pr-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400/50"
              onChange={(e) => {
                const q = e.target.value.toLowerCase();
                const items = Array.from(document.querySelectorAll("[data-thread-item]"));
                items.forEach((el) => {
                  const t = (el.getAttribute("data-search") || "").toLowerCase();
                  el.style.display = t.includes(q) ? "" : "none";
                });
              }}
            />
          </div>
          <button
            onClick={onNew}
            className="inline-flex items-center gap-1 rounded-md border border-white/15 bg-white/5 px-2 py-1 text-sm hover:bg-white/10"
          >
            <Plus className="h-4 w-4" /> New
          </button>
        </div>
      </div>

      {/* List */}
      <div id="chat-scroll" className="flex-1 overflow-y-auto px-2 py-2 space-y-1">
        {threads.length === 0 ? (
          <div className="p-3 text-xs text-white/50">No conversations yet.</div>
        ) : (
          threads.map((t) => {
            const name = displayForNumber(t.partnerNumber);
            const small = smallPhoneForNumber(t.partnerNumber);
            return (
              <button
                key={t.partnerNumber}
                onClick={() => onOpen(t.partnerNumber)}
                data-thread-item
                data-search={`${name} ${small} ${t.lastMessage}`}
                className="w-full rounded-xl border border-white/10 bg-white/[0.03] p-3 text-left hover:bg-white/[0.06]"
              >
                <div className="text-sm font-medium truncate">{name}</div>
                {small ? (
                  <>
                    <div className="truncate text-xs text-white/60">{small}</div>
                    <div className="truncate text-[11px] text-white/40">{t.lastMessage}</div>
                  </>
                ) : (
                  <div className="truncate text-xs text-white/60">{t.lastMessage}</div>
                )}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

function MobileChat({
  activeNumber,
  conversation,
  scrollerRef,
  displayForNumber,
  smallPhoneForNumber,
  text,
  setText,
  sending,
  balanceCents,
  onBack,
  onRename,
  onRemove,
  onSend,
}) {
  return (
    <div className="h-full flex flex-col">
      {/* Chat header */}
      <div className="sticky top-0 z-10 border-b border-white/10 bg-white/[0.02] px-2 py-2">
        <div className="flex items-center gap-2">
          <button
            onClick={onBack}
            className="p-1 rounded-lg border border-white/15 bg-white/5 hover:bg-white/10"
            aria-label="Back"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <div className="flex-1">
            <div className="text-sm font-semibold truncate">{displayForNumber(activeNumber)}</div>
            {smallPhoneForNumber(activeNumber) && (
              <div className="text-[11px] text-white/60 truncate">
                {smallPhoneForNumber(activeNumber)}
              </div>
            )}
          </div>
          <button
            onClick={onRename}
            className="rounded-md border border-white/15 bg-white/5 px-2 py-1 text-[11px] hover:bg-white/10"
            title="Rename"
          >
            <Edit3 className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={onRemove}
            className="rounded-md border border-rose-400/30 bg-rose-500/10 px-2 py-1 text-[11px] text-rose-200 hover:bg-rose-500/20"
            title="Remove"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Messages */}
      <div
        ref={scrollerRef}
        id="chat-scroll"
        className="flex-1 overflow-y-auto px-3 py-2 space-y-2"
      >
        {conversation.length === 0 ? (
          <div className="grid h-full place-items-center text-sm text-white/50">No messages yet.</div>
        ) : (
          conversation.map((m) => {
            const isOut = m.direction === "out" || m.direction === "outgoing";
            return (
              <div key={m.id} className={classNames("mb-2 flex", isOut ? "justify-end" : "justify-start")}>
                <div
                  className={classNames(
                    "max-w-[82%] rounded-2xl px-3 py-2 text-sm leading-snug ring-1 break-words [overflow-wrap:anywhere]",
                    isOut
                      ? "bg-gradient-to-r from-indigo-500/30 via-purple-500/30 to-fuchsia-500/30 ring-indigo-400/30"
                      : "bg-white/5 ring-white/10"
                  )}
                  title={new Date(m.created_at).toLocaleString()}
                >
                  <div>{m.body}</div>
                  {isOut && (
                    <div className="mt-1 text-[10px] uppercase tracking-wide text-white/50">{m.status}</div>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Composer */}
      <div className="border-t border-white/10 px-3 pt-3 pb-[calc(env(safe-area-inset-bottom)+10px)]">
        <div className="flex items-end gap-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Type a message…"
            disabled={sending}
            rows={1}
            className="min-h-[44px] w-full resize-none rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-base leading-tight placeholder:text-white/40 focus:outline-none focus:ring-1 focus:ring-indigo-400/50 max-h-40"
          />
          <button
            onClick={onSend}
            disabled={!text.trim() || sending || balanceCents <= 0}
            className={classNames(
              "inline-flex h-[44px] items-center gap-2 rounded-xl border px-4 font-medium",
              "border-white/15 bg-white/5 hover:bg-white/10",
              (!text.trim() || sending || balanceCents <= 0) && "opacity-50 cursor-not-allowed"
            )}
          >
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Send
          </button>
        </div>
        {balanceCents <= 0 && (
          <div className="mt-2 text-xs text-amber-300/90">
            Your balance is $0. Add funds to send messages.
          </div>
        )}
      </div>
    </div>
  );
}
