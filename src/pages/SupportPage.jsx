// File: src/pages/SupportPage.jsx
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabaseClient.js";
import useIsAdminAllowlist from "../lib/useIsAdminAllowlist.js";
import TicketThread from "../components/TicketThread.jsx";

export default function SupportPage() {
  const [form, setForm] = useState({
    name: "",
    email: "",
    subject: "",
    message: "",
    severity: "normal",
  });
  const [loading, setLoading] = useState(false);
  const [ok, setOk] = useState(null);
  const [err, setErr] = useState("");

  const [myTickets, setMyTickets] = useState([]);
  const [selected, setSelected] = useState(null);

  const { isAdmin } = useIsAdminAllowlist();

  const onChange = (e) =>
    setForm((f) => ({ ...f, [e.target.name]: e.target.value }));

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true);
    setOk(null);
    setErr("");

    const {
      data: { user },
    } = await supabase.auth.getUser();

    try {
      const res = await fetch("/.netlify/functions/support-ticket", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: user?.id || null,
          ...form,
          path: window.location.pathname,
          meta: { ua: navigator.userAgent },
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || "Failed");

      setOk(true);
      setForm({
        name: "",
        email: "",
        subject: "",
        message: "",
        severity: "normal",
      });
      await loadMyTickets();
      setSelected(json.ticket);
    } catch (e2) {
      setErr(e2.message);
      setOk(false);
    } finally {
      setLoading(false);
    }
  }

  async function loadMyTickets() {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user?.id) return;

    const { data, error } = await supabase
      .from("support_tickets")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(50);

    if (!error) setMyTickets(data || []);
  }

  useEffect(() => {
    loadMyTickets();

    const ch = supabase
      .channel("support_tickets_my")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "support_tickets" },
        (payload) => setMyTickets((prev) => [payload.new, ...prev])
      )
      .subscribe();

    return () => {
      supabase.removeChannel(ch);
    };
  }, []);

  return (
    <div className="max-w-5xl mx-auto p-6">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-semibold">Support</h1>

        {/* Admin-only quick link */}
        {isAdmin && (
          <Link
            to="/app/support-inbox"
            className="text-sm rounded px-3 py-1 border border-indigo-500 text-indigo-300 hover:bg-indigo-500/10"
            title="View all tickets (admin)"
          >
            Open Support Inbox
          </Link>
        )}
      </div>

      {/* Submit a ticket */}
      <form onSubmit={handleSubmit} className="grid gap-3 max-w-xl">
        <input
          name="name"
          placeholder="Your name"
          className="border rounded p-2"
          value={form.name}
          onChange={onChange}
          required
        />
        <input
          name="email"
          type="email"
          placeholder="Your email"
          className="border rounded p-2"
          value={form.email}
          onChange={onChange}
          required
        />
        <input
          name="subject"
          placeholder="Subject"
          className="border rounded p-2"
          value={form.subject}
          onChange={onChange}
          required
        />
        <select
          name="severity"
          className="border rounded p-2"
          value={form.severity}
          onChange={onChange}
        >
          <option value="low">Low</option>
          <option value="normal">Normal</option>
          <option value="high">High</option>
        </select>
        <textarea
          name="message"
          placeholder="Describe your issue"
          className="border rounded p-2 min-h-32"
          value={form.message}
          onChange={onChange}
          required
        />
        <button
          disabled={loading}
          className="rounded bg-indigo-600 text-white p-2 disabled:opacity-60"
        >
          {loading ? "Sending..." : "Send"}
        </button>
        {ok && (
          <p className="text-green-600">
            Sent! We’ll get back to you shortly.
          </p>
        )}
        {err && <p className="text-red-600">Error: {err}</p>}
      </form>

      {/* My tickets */}
      <div className="mt-10">
        <h2 className="text-xl font-semibold mb-3">My tickets</h2>

        {myTickets.length === 0 ? (
          <p className="text-sm text-gray-400">No tickets yet.</p>
        ) : (
          <div className="grid gap-2">
            {myTickets.map((t) => (
              <button
                key={t.id}
                onClick={() => setSelected(t)}
                className={`text-left border rounded p-3 hover:bg-white/5 ${
                  selected?.id === t.id ? "bg-white/5" : ""
                }`}
              >
                <div className="flex justify-between">
                  <div className="font-medium">
                    {t.subject || "(no subject)"} •{" "}
                    <span className="uppercase">{t.severity}</span>
                  </div>
                  <div className="text-sm">{t.status}</div>
                </div>
                <div className="text-sm text-gray-400">
                  {new Date(t.created_at).toLocaleString()}
                </div>
                {t.path && (
                  <div className="text-xs text-gray-500 mt-1">Path: {t.path}</div>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Thread viewer */}
      {selected && (
        <div className="mt-6">
          <TicketThread
            ticket={selected}
            canReply
            isAdminView={false}
            onClose={() => setSelected(null)}
          />
        </div>
      )}
    </div>
  );
}
