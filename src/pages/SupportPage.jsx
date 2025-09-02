// File: src/pages/SupportPage.jsx
import { useState } from "react";

export default function SupportPage() {
  const [form, setForm] = useState({ name: "", email: "", phone: "", reason: "" });
  const [status, setStatus] = useState({ sending: false, ok: null, msg: "" });

  const onChange = (e) => setForm({ ...form, [e.target.name]: e.target.value });

  async function onSubmit(e) {
    e.preventDefault();
    setStatus({ sending: true, ok: null, msg: "" });

    try {
      const res = await fetch("/.netlify/functions/support-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Failed to send");

      setStatus({ sending: false, ok: true, msg: "Thanks! We’ll get back to you shortly." });
      setForm({ name: "", email: "", phone: "", reason: "" });
    } catch (err) {
      setStatus({ sending: false, ok: false, msg: err.message || "Something went wrong." });
    }
  }

  return (
    <div className="max-w-xl mx-auto p-6">
      <h1 className="text-2xl font-semibold mb-2">Support</h1>
      <p className="text-sm text-gray-600 mb-6">
        Have a question or need help? Send us a message and we’ll reach out.
      </p>

      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <label className="block text-sm mb-1">Name</label>
          <input
            name="name"
            value={form.name}
            onChange={onChange}
            required
            className="w-full border rounded-lg p-2"
            placeholder="Your name"
          />
        </div>

        <div>
          <label className="block text-sm mb-1">Email</label>
          <input
            type="email"
            name="email"
            value={form.email}
            onChange={onChange}
            required
            className="w-full border rounded-lg p-2"
            placeholder="you@example.com"
          />
        </div>

        <div>
          <label className="block text-sm mb-1">Phone</label>
          <input
            name="phone"
            value={form.phone}
            onChange={onChange}
            className="w-full border rounded-lg p-2"
            placeholder="(555) 123-4567"
          />
        </div>

        <div>
          <label className="block text-sm mb-1">Reason</label>
          <textarea
            name="reason"
            value={form.reason}
            onChange={onChange}
            required
            rows={5}
            className="w-full border rounded-lg p-2"
            placeholder="Tell us what you need help with…"
          />
        </div>

        <button
          type="submit"
          disabled={status.sending}
          className="px-4 py-2 rounded-xl border shadow-sm"
        >
          {status.sending ? "Sending..." : "Send"}
        </button>

        {status.ok === true && (
          <div className="text-green-600 text-sm mt-2">{status.msg}</div>
        )}
        {status.ok === false && (
          <div className="text-red-600 text-sm mt-2">{status.msg}</div>
        )}
      </form>
    </div>
  );
}
