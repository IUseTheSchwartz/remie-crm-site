// File: src/pages/MessagesPage.jsx
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { ExternalLink, Send, Phone, Mail, MessageSquare, MessageCircle } from "lucide-react";

/**
 * This page is provider-agnostic UI that calls your backend:
 *   GET  /api/sendblue/conversations?search=&limit=50
 *   GET  /api/sendblue/conversations/:id/messages
 *   POST /api/sendblue/messages  { conversationId, body, channel: "imessage"|"sms" }
 *
 * Your backend should:
 *   - hold SEND BLUE API KEY (server-side only)
 *   - translate these to Sendblue API calls
 *   - normalize responses to { id, name, lastMessageAt, unreadCount, preview, ... }
 */

function Pill({ active, children, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full px-3 py-1 text-xs ${
        active ? "bg-white text-black" : "bg-white/10 text-white/80 hover:bg-white/15"
      }`}
    >
      {children}
    </button>
  );
}

function TextInput({ value, onChange, placeholder, onEnter }) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => e.key === "Enter" && onEnter?.()}
      placeholder={placeholder}
      className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 outline-none"
    />
  );
}

export default function MessagesPage() {
  const [search, setSearch] = useState("");
  const [convos, setConvos] = useState([]);
  const [loadingConvos, setLoadingConvos] = useState(true);

  const [activeId, setActiveId] = useState(null);
  const [thread, setThread] = useState([]);
  const [loadingThread, setLoadingThread] = useState(false);

  const [contact, setContact] = useState(null);
  const [composer, setComposer] = useState("");
  const [channel, setChannel] = useState("imessage"); // "imessage" or "sms"

  const bottomRef = useRef(null);

  // Load conversations list
  async function fetchConversations() {
    setLoadingConvos(true);
    try {
      const res = await fetch(`/api/sendblue/conversations?search=${encodeURIComponent(search)}&limit=50`);
      const json = await res.json();
      setConvos(json || []);
      if (!activeId && json?.length) setActiveId(json[0].id);
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingConvos(false);
    }
  }

  // Load thread + contact when activeId changes
  async function fetchThread(id) {
    if (!id) return;
    setLoadingThread(true);
    try {
      const res = await fetch(`/api/sendblue/conversations/${id}/messages`);
      const json = await res.json();
      setThread(json?.messages || []);
      setContact(json?.contact || null);
      // scroll to bottom after load
      setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingThread(false);
    }
  }

  async function sendMessage() {
    const text = composer.trim();
    if (!text || !activeId) return;
    setComposer("");

    // optimistic add
    const optimistic = {
      id: `tmp-${Date.now()}`,
      body: text,
      direction: "out",
      at: new Date().toISOString(),
      channel,
    };
    setThread((prev) => [...prev, optimistic]);
    setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 10);

    try {
      await fetch(`/api/sendblue/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: activeId, body: text, channel }),
      });
      // Optionally re-fetch to replace optimistic ID with real one
      fetchThread(activeId);
    } catch (e) {
      console.error(e);
      // revert optimistic on error
      setThread((prev) => prev.filter((m) => m.id !== optimistic.id));
      alert("Failed to send message.");
    }
  }

  // initial + search debounce
  useEffect(() => {
    const t = setTimeout(fetchConversations, 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    fetchConversations();
  }, []);

  useEffect(() => {
    if (activeId) fetchThread(activeId);
  }, [activeId]);

  const sortedConvos = useMemo(() => {
    return [...convos].sort((a, b) => new Date(b.lastMessageAt || 0) - new Date(a.lastMessageAt || 0));
  }, [convos]);

  return (
    <div className="grid min-h-[calc(100vh-140px)] grid-cols-1 bg-neutral-950 text-white md:grid-cols-[320px_1fr_300px]">
      {/* LEFT: Conversation list */}
      <aside className="border-r border-white/10">
        <div className="p-3">
          <TextInput value={search} onChange={setSearch} placeholder="Search" />
        </div>

        {loadingConvos ? (
          <div className="p-3 text-sm text-white/60">Loading conversations…</div>
        ) : (
          <div className="max-h-[calc(100vh-220px)] overflow-y-auto">
            {sortedConvos.map((c) => (
              <button
                key={c.id}
                onClick={() => setActiveId(c.id)}
                className={`flex w-full items-center gap-3 px-3 py-3 text-left hover:bg-white/5 ${
                  activeId === c.id ? "bg-white/5" : ""
                }`}
              >
                <div className="grid h-9 w-9 place-items-center rounded-full bg-white/10 text-sm font-medium">
                  {((c.name || "").trim()[0] || "?").toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <div className="truncate text-sm font-medium">{c.name || c.number || "Unknown"}</div>
                    {c.unreadCount ? (
                      <span className="rounded-full bg-indigo-500 px-2 py-0.5 text-[10px] font-semibold">{c.unreadCount}</span>
                    ) : null}
                  </div>
                  <div className="truncate text-xs text-white/60">{c.preview || ""}</div>
                </div>
              </button>
            ))}
            {!sortedConvos.length && (
              <div className="p-3 text-xs text-white/50">No conversations yet.</div>
            )}
          </div>
        )}
      </aside>

      {/* MIDDLE: Active thread */}
      <section className="flex flex-col">
        {/* header */}
        <div className="flex items-center justify-between border-b border-white/10 bg-black/30 px-4 py-3">
          <div className="text-sm font-medium">
            {contact?.name || contact?.number || "Conversation"}
          </div>
          {contact?.publicUrl ? (
            <a
              href={contact.publicUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs text-indigo-300 underline"
            >
              Open in Sendblue <ExternalLink className="h-3.5 w-3.5" />
            </a>
          ) : null}
        </div>

        {/* messages */}
        <div className="flex-1 space-y-2 overflow-y-auto p-3">
          {loadingThread ? (
            <div className="p-3 text-sm text-white/60">Loading messages…</div>
          ) : (
            <>
              {thread.map((m) => (
                <div
                  key={m.id}
                  className={`max-w-[72%] rounded-2xl px-3 py-2 text-sm ${
                    m.direction === "out"
                      ? "ml-auto bg-indigo-500/90 text-white"
                      : "bg-white/10 text-white/90"
                  }`}
                  title={new Date(m.at).toLocaleString()}
                >
                  {m.body}
                </div>
              ))}
              <div ref={bottomRef} />
            </>
          )}
        </div>

        {/* composer */}
        <div className="border-t border-white/10 p-3">
          <div className="mb-2 flex items-center gap-2">
            <Pill active={channel === "imessage"} onClick={() => setChannel("imessage")}>
              <MessageCircle className="mr-1 inline h-3.5 w-3.5" />
              iMessage
            </Pill>
            <Pill active={channel === "sms"} onClick={() => setChannel("sms")}>
              <MessageSquare className="mr-1 inline h-3.5 w-3.5" />
              SMS
            </Pill>
          </div>
          <div className="flex items-center gap-2">
            <TextInput
              value={composer}
              onChange={setComposer}
              onEnter={sendMessage}
              placeholder={`Type a ${channel === "imessage" ? "blue" : "SMS"} message…`}
            />
            <button
              onClick={sendMessage}
              className="grid h-10 w-10 place-items-center rounded-xl bg-white text-black hover:bg-neutral-200"
              title="Send"
            >
              <Send className="h-5 w-5" />
            </button>
          </div>
          <div className="mt-2 text-[11px] text-white/50">
            Include “Reply STOP to opt out” in outreach sequences to stay compliant.
          </div>
        </div>
      </section>

      {/* RIGHT: Contact panel */}
      <aside className="hidden border-l border-white/10 bg-black/20 p-4 md:block">
        <div className="text-sm font-semibold">Contact</div>
        <div className="mt-3 space-y-2 text-sm text-white/80">
          <div><span className="text-white/50">Name:</span> {contact?.name || "—"}</div>
          <div><span className="text-white/50">Phone:</span> {contact?.number || "—"}</div>
          <div><span className="text-white/50">Email:</span> {contact?.email || "—"}</div>
        </div>

        {contact?.tags?.length ? (
          <>
            <div className="mt-4 text-sm font-semibold">Tags</div>
            <div className="mt-2 flex flex-wrap gap-2">
              {contact.tags.map((t) => (
                <span key={t} className="rounded-full bg-white/10 px-2 py-0.5 text-xs">{t}</span>
              ))}
            </div>
          </>
        ) : null}

        {contact?.automations?.length ? (
          <>
            <div className="mt-4 text-sm font-semibold">Active Automations</div>
            <ul className="mt-2 space-y-1 text-sm text-white/80">
              {contact.automations.map((a) => (
                <li key={a.id}>• {a.name}</li>
              ))}
            </ul>
          </>
        ) : null}
      </aside>
    </div>
  );
}
