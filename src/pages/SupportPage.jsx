import { useState } from "react";
import { supabase } from "../lib/supabaseClient.js";

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
      setForm({ name: "", email: "", subject: "", message: "", severity: "normal" });
    } catch (e2) {
      setErr(e2.message);
      setOk(false);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="max-w-xl mx-auto p-6">
      <h1 className="text-2xl font-semibold mb-4">Support</h1>
      <form onSubmit={handleSubmit} className="grid gap-3">
        <input name="name" placeholder="Your name" className="border rounded p-2" value={form.name} onChange={onChange} required />
        <input name="email" type="email" placeholder="Your email" className="border rounded p-2" value={form.email} onChange={onChange} required />
        <input name="subject" placeholder="Subject" className="border rounded p-2" value={form.subject} onChange={onChange} required />
        <select name="severity" className="border rounded p-2" value={form.severity} onChange={onChange}>
          <option value="low">Low</option>
          <option value="normal">Normal</option>
          <option value="high">High</option>
        </select>
        <textarea name="message" placeholder="Describe your issue" className="border rounded p-2 min-h-32" value={form.message} onChange={onChange} required />
        <button disabled={loading} className="rounded bg-indigo-600 text-white p-2 disabled:opacity-60">
          {loading ? "Sending..." : "Send"}
        </button>
        {ok && <p className="text-green-600">Sent! We’ll get back to you shortly.</p>}
        {err && <p className="text-red-600">Error: {err}</p>}
      </form>
    </div>
  );
}
