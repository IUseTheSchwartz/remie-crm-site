// File: src/pages/SupportPage.jsx
import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient.js";
import { Link } from "react-router-dom";
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

  const onChange = (e) => setForm((f) => ({ ...f, [e.target.name]: e.target.value }));

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true);
    setOk(null);
    setErr("");

    const { data: { user } } = await supabase.auth.getUser();

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
      setForm({ name: "", email: "", subject: "", message: "", severity: "normal" });
      await loadMyTickets(); // refresh list
      setSelected(json.ticket); // open the new ticket thread
    } catch (e2) {
      setErr(e2.message);
      setOk(false);
    } finally {
      setLoading(false);
    }
  }

  async function loadMyTickets() {
    const { data: { user } } = await supabase.auth.getUser();
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

    // realtime: if a new ticket by this user appears
    const ch = supabase
      .channel("support_tickets_my")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "support_tickets" },
        (payload) => {
          setMyTickets((prev) => [payload.new, ...prev]);
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(ch); };
  }, []);

  return (
    <div className="max-w-5xl mx-auto p-6">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-semibold">Support</h1>

        {/* Admin-only quick link to the full inbox */}
        {isAdmin && (
          <Link
            to="/app/support-inbox"
            className="text-sm rounded px-3 py-1 border border-indigo-500 text-indigo-300 hover:bg-indigo-500/10"
          >
            Open Support Inbox
          </Link>
        )}
      </div>

      {/* Submit a new ticket */}
      <form onSubmit={handleSubmit} className="grid gap-3 max-w-xl">
        <input name="name" placeholder="Your nam
