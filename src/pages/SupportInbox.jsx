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

  // Debug bits
  const { isAdmin, loading: adminLoading } = useIsAdminAllowlist();
  const [meEmail, setMeEmail] = useState(null);
  const [allowEmail, setAllowEmail] = useState(null);
  const [allowErr, setAllowErr] = useState("");
  const [projectUrl, setProjectUrl] = useState(import.meta.env.VITE_SUPABASE_URL || "(env missing)");

  async function loadWhoAmI() {
    const { data: { user }, error } = await supabase.auth.getUser();
    if (!error) setMeEmail(user?.email ?? null);

    // RLS allows selecting ONLY your own allowlist row; no filter needed.
    const { data: meAllow, error: aErr } = await supabase
      .from("admin_allowlist")
      .select("email")
      .maybeSingle();

    if (aErr) {
      setAllowErr(aErr.message || String(aErr));
      setAllowEmail(null);
    } else {
      setAllowErr("");
      setAllowEmail(meAllow?.email ?? null);
    }
  }

  async function loadTickets() {
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
    // load identity + allowlist proof
    loadWhoAmI();

    // load tickets + subscribe for new ones
    loadTickets();
    const ch = supabase
      .channel("support_tickets_all")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "support_tickets" },
        () => loadTickets()
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
      <div className="text-xs text-gray-400 mb-4 space-y-1">
        <div>Project URL (env): {projectUrl}</div>
        <div>Session email: {meEmail || "(none)"} </div>
        <div>
          Admin allowlist (hook): {adminLoading ? "checking…" : String(isAdmin)}
        </div>
        <div>
          Allowlist row (RLS query): {allowErr ? (
            <span className="text-red-400">error: {allowErr}</span>
          ) : (
            allowEmail || "(none)"
          )}
        </div>
        <div>Tickets visible: {tickets?.length ?? 0}{err ? ` — error: ${err}` : ""}</div>
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
