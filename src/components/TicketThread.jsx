// File: src/components/TicketThread.jsx
import { useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabaseClient.js";

export default function TicketThread({ ticket, canReply = true, isAdminView = false, onClose }) {
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const bottomRef = useRef(null);

  const ticketId = ticket?.id;

  async function load() {
    if (!ticketId) return;

    // 1) base (initial) message from ticket
    const base = ticket.message
      ? [{
          id: "initial",
          created_at: ticket.created_at,
          ticket_id: ticketId,
          sender_user_id: ticket.user_id,
          sender_email: ticket.email,
          is_admin: false,
          body: ticket.message,
        }]
      : [];

    // 2) threaded replies
    const { data: threaded } = await supabase
      .from("support_messages")
      .select("*")
      .eq("ticket_id", ticketId)
      .order("created_at", { ascending: true });

    setMessages([...(base || []), ...(threaded || [])]);
    setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 0);
  }

  useEffect(() => {
    load();
    if (!ticketId) return;

    const ch = supabase
      .channel(`support_messages:${ticketId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "support_messages", filter: `ticket_id=eq.${ticketId}` },
        (payload) => {
          setMessages((prev) => [...prev, payload.new]);
          setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 0);
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(ch); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticketId]);

  async function sendReply(e) {
    e?.preventDefault?.();
    if (!text.trim()) return;
    setSending(true);

    const { data: { user } } = await supabase.auth.getUser();

    const { error } = await supabase.from("support_messages").insert({
      ticket_id: ticketId,
      body: text.trim(),
      is_admin: !!isAdminView,
      sender_user_id: user?.id || null,
      sender_email: user?.email || null,
    });

    if (!error) setText("");
    setSending(false);
  }

  return (
    <div className="border rounded-lg p-3 bg-black/20">
      <div className="flex items-center justify-between mb-2">
        <div className="font-semibold">
          {ticket.subject || "(no subject)"} • <span className="uppercase">{ticket.severity}</span>
        </div>
        {onClose && (
          <button onClick={onClose} className="text-xs px-2 py-1 border rounded hover:bg-white/5">
            Close
          </button>
        )}
      </div>

      <div className="space-y-3 max-h-80 overflow-auto pr-1">
        {messages.map((m) => (
          <div key={m.id} className="text-sm">
            <div className="text-gray-400">
              {m.is_admin ? "Support" : (m.sender_email || "User")} • {new Date(m.created_at).toLocaleString()}
            </div>
            <div className="whitespace-pre-wrap border rounded p-2 mt-1">{m.body}</div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {canReply && (
        <form onSubmit={sendReply} className="mt-3 grid gap-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Write a reply…"
            className="border rounded p-2 min-h-20"
          />
          <div className="flex gap-2 justify-end">
            <button disabled={sending || !text.trim()} className="rounded bg-indigo-600 text-white px-3 py-1 disabled:opacity-60">
              {sending ? "Sending…" : "Send"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
