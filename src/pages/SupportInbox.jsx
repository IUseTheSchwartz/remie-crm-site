// File: src/pages/SupportInbox.jsx
import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient.js";
import TicketThread from "../components/TicketThread.jsx";
import useIsAdminAllowlist from "../lib/useIsAdminAllowlist.js";

export default function SupportInbox() {
  const [tickets, setTickets] = useState([]);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  // 👇 Debug: shows whether the app recognizes you as allowlisted admin
  const { isAdmin, loading: adminLoading } = useIsAdminAllowlist();

  async function load() {
    setLoading(true);
    setErr("");
    const { data, error } = await supabase
      .from("support_tickets")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(200);

    if (error) {
      console.error("support_tickets error", error);
      setErr(error.message || "Failed to load tickets");
      setTickets([]);
    } else {
      setTickets(data || []);
    }
    setLoading(false);
  }

  useEffect(() => {
    load();
    const ch = supabase
      .channel("support_tickets_all")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "support_tickets" },
        () => load()
      )
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, []);

  return (
    <div className="p-6">
      <h1 className="text-2xl font-semibold mb-2">Support Inbox</h1>

      {/* 🔍 Debug strip */}
      <div className="text-xs text-gray-400 mb-4">
        Admin allowlist: {adminLoading ? "checking…" : String(isAdmin)} • Tickets loaded: {tickets?.length ?? 0}
        {err && <span className="text-red-400"> • Error: {err}</span>}
      </div>

      <div className="grid lg:grid-cols-2 gap-6">
        {/* Left: tickets list */}
        <div>
          {loading && <p>Loading…</p>}
          <div className="grid gap-2">
            {tickets.map((t) => (
              <button
                key={t.id}
                onClick={() => setSelected(t)}
                className={`text-left border rounded p-3 hover:bg-white/5 ${selected?.id === t.id ? "bg-white/5" : ""}`}
              >
                <div className="flex justify-between">
                  <div className="font-medium">
                    {t.subject || "(no subject)"} • <span className="uppercase">{t.severity}</span>
                  </div>
                  <div className="text-sm">{t.status}</div>
                </div>
                <div className="text-sm text-gray-400">
                  {t.name} &lt;{t.email}&gt; • {new Date(t.created_at).toLocaleString()}
                </div>
                {t.path && <div className="text-xs text-gray-500 mt-1">Path: {t.path}</div>}
              </button>
            ))}
            {!loading && tickets.length === 0 && (
              <p className="text-sm text-gray-400">No tickets yet.</p>
            )}
          </div>
        </div>

        {/* Right: thread */}
        <div>
          {selected ? (
            <TicketThread ticket={selected} canReply isAdminView />
          ) : (
            <div className="text-sm text-gray-400">Select a ticket to view the thread.</div>
          )}
        </div>
      </div>
    </div>
  );
}
