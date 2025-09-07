// File: src/pages/RebuttalChat.jsx
import { useEffect, useRef, useState } from "react";

function Section({ title, items }) {
  if (!items?.length) return null;
  return (
    <section className="mb-5">
      <h3 className="text-sm font-semibold text-white/90 mb-2">{title}</h3>
      <ul className="list-disc pl-5 space-y-1 text-sm text-white/90">
        {items.map((t, i) => (
          <li key={i} className="leading-6">{t}</li>
        ))}
      </ul>
    </section>
  );
}

function AssistantCard({ data }) {
  if (!data) return null;
  return (
    <div className="max-w-[80%] rounded-lg px-4 py-3 bg-black text-white border border-gray-700 shadow">
      <Section title="What likely went wrong" items={data.why} />
      <Section title="How to fix it next time" items={data.fix} />
      <Section title="Rebuttals" items={data.rebuttals} />
    </div>
  );
}

function Bubble({ role, text }) {
  const isUser = role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"} mb-3`}>
      <div
        className={`max-w-[80%] rounded-lg px-3 py-2 text-sm leading-6 shadow
          ${isUser ? "bg-violet-600 text-white" : "bg-black text-white border border-gray-700"}`}
      >
        {text}
      </div>
    </div>
  );
}

function RebuttalChat() {
  const [messages, setMessages] = useState([
    {
      role: "assistant",
      text:
        "Tell me what happened. Paste the objection or describe the call. " +
        "I’ll coach you and give 2–3 ready-to-use rebuttals.",
    },
  ]);
  const [structured, setStructured] = useState(null); // holds JSON result
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [product, setProduct] = useState("Final Expense");
  const [tone, setTone] = useState("Direct & supportive");
  const scrollerRef = useRef(null);

  useEffect(() => {
    scrollerRef.current?.scrollTo({ top: scrollerRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, structured]);

  async function sendMessage(e) {
    e?.preventDefault();
    const content = input.trim();
    if (!content || sending) return;

    setStructured(null);
    setMessages((m) => [...m, { role: "user", text: content }]);
    setInput("");
    setSending(true);

    try {
      const res = await fetch("/.netlify/functions/rebuttal-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, product, tone }),
      });
      if (!res.ok) throw new Error(`Server error: ${res.status}`);
      const data = await res.json(); // {why, fix, rebuttals}
      setStructured(data);
    } catch (err) {
      setMessages((m) => [...m, { role: "assistant", text: "Sorry—something went wrong. Try again." }]);
      console.error(err);
    } finally {
      setSending(false);
    }
  }

  function resetChat() {
    setMessages([{ role: "assistant", text: "New chat. Summarize the call or paste the objection." }]);
    setStructured(null);
  }

  return (
    <div className="h-full w-full max-w-4xl mx-auto flex flex-col bg-black text-white rounded-lg shadow-lg border border-gray-800">
      <header className="p-4 border-b border-gray-800 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">AI Rebuttal Helper</h1>
          <p className="text-xs text-gray-400">Stateless chat — nothing is stored.</p>
        </div>
        <div className="flex gap-2">
          <select
            className="border rounded px-2 py-1 text-sm bg-black text-white border-gray-700
                       hover:shadow-[0_0_12px_rgba(139,92,246,0.9)]
                       focus:outline-none focus:ring-2 focus:ring-violet-600 transition"
            value={product}
            onChange={(e) => setProduct(e.target.value)}
            title="Product context"
          >
            <option>Final Expense</option>
            <option>Term</option>
            <option>IUL</option>
            <option>Whole Life</option>
          </select>
          <select
            className="border rounded px-2 py-1 text-sm bg-black text-white border-gray-700
                       hover:shadow-[0_0_12px_rgba(139,92,246,0.9)]
                       focus:outline-none focus:ring-2 focus:ring-violet-600 transition"
            value={tone}
            onChange={(e) => setTone(e.target.value)}
            title="Coaching tone"
          >
            <option>Direct & supportive</option>
            <option>Empathetic</option>
            <option>Strict manager</option>
            <option>Bullet-point & concise</option>
          </select>
          <button
            onClick={resetChat}
            className="border rounded px-2 py-1 text-sm hover:shadow-[0_0_10px_rgba(139,92,246,0.8)] transition"
            type="button"
          >
            Reset
          </button>
        </div>
      </header>

      <main ref={scrollerRef} className="flex-1 overflow-y-auto p-4">
        {messages.map((m, i) => (
          <Bubble key={`m-${i}`} role={m.role} text={m.text} />
        ))}
        {structured && (
          <div className="flex justify-start mt-3">
            <AssistantCard data={structured} />
          </div>
        )}
      </main>

      <form onSubmit={sendMessage} className="p-4 border-t border-gray-800 bg-black">
        <div className="flex gap-2">
          <textarea
            className="flex-1 border rounded px-3 py-2 text-sm h-24 bg-black text-white border-gray-700
                       placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-violet-600"
            placeholder={`Example:
Prospect: "Let me talk to my wife."
Me: Confirmed beneficiary, didn't ask health changes or review date. I froze and said okay.`}
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <button
            type="submit"
            disabled={sending}
            className="px-4 py-2 rounded bg-violet-600 text-white text-sm hover:shadow-[0_0_15px_rgba(139,92,246,0.8)] disabled:opacity-60 transition"
          >
            {sending ? "Thinking…" : "Send"}
          </button>
        </div>
      </form>
    </div>
  );
}

// 👇 THIS LINE IS WHAT Vite/Netlify EXPECTS
export default RebuttalChat;
