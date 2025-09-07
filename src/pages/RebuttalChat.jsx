import { useEffect, useRef, useState } from "react";

function Bubble({ role, text }) {
  const isUser = role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"} mb-3`}>
      <div
        className={`max-w-[80%] rounded-lg px-3 py-2 text-sm leading-6 shadow
          ${isUser ? "bg-violet-600 text-white" : "bg-gray-100 text-gray-900"}`}
      >
        {text}
      </div>
    </div>
  );
}

export default function RebuttalChat() {
  const [messages, setMessages] = useState([
    {
      role: "assistant",
      text:
        "Tell me what happened on the call/text. Paste the objection or describe what you think went wrong. " +
        "I’ll coach you and give 2–3 ready-to-use rebuttals.",
    },
  ]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [product, setProduct] = useState("Final Expense");
  const [tone, setTone] = useState("Direct & supportive");
  const scrollerRef = useRef(null);

  useEffect(() => {
    scrollerRef.current?.scrollTo({ top: scrollerRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  async function sendMessage(e) {
    e?.preventDefault();
    const content = input.trim();
    if (!content || sending) return;

    // Push user bubble
    setMessages((m) => [...m, { role: "user", text: content }]);
    setInput("");
    setSending(true);

    // Create assistant placeholder for streaming
    const aiIndex = messages.length + 1; // after pushing user
    setMessages((m) => [...m, { role: "assistant", text: "" }]);

    try {
      const res = await fetch("/.netlify/functions/rebuttal-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, product, tone }),
      });
      if (!res.ok || !res.body) throw new Error(`Server error: ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let done = false;

      while (!done) {
        const { value, done: readerDone } = await reader.read();
        done = readerDone;
        const chunk = decoder.decode(value || new Uint8Array(), { stream: !done });

        if (chunk) {
          // Append streamed text to the last assistant message
          setMessages((m) => {
            const copy = [...m];
            copy[aiIndex] = { ...copy[aiIndex], text: (copy[aiIndex].text || "") + chunk };
            return copy;
          });
        }
      }
    } catch (err) {
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          text: "Sorry—something went wrong. Try again in a moment.",
        },
      ]);
      console.error(err);
    } finally {
      setSending(false);
    }
  }

  function resetChat() {
    setMessages([
      {
        role: "assistant",
        text:
          "New chat. Paste the objection or summarize the call. I’ll analyze, coach, and give tight rebuttals.",
      },
    ]);
  }

  return (
    <div className="h-full w-full max-w-4xl mx-auto flex flex-col">
      <header className="p-4 border-b flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">AI Rebuttal Helper</h1>
          <p className="text-xs text-gray-500">
            Stateless chat — nothing is stored. Close the tab = history is gone.
          </p>
        </div>
        <div className="flex gap-2">
          <select
            className="border rounded px-2 py-1 text-sm"
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
            className="border rounded px-2 py-1 text-sm"
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
            className="border rounded px-2 py-1 text-sm hover:bg-gray-50"
            type="button"
          >
            Reset
          </button>
        </div>
      </header>

      <main ref={scrollerRef} className="flex-1 overflow-y-auto p-4 bg-white">
        {messages.map((m, i) => (
          <Bubble key={i} role={m.role} text={m.text} />
        ))}
      </main>

      <form onSubmit={sendMessage} className="p-4 border-t bg-white">
        <div className="flex gap-2">
          <textarea
            className="flex-1 border rounded px-3 py-2 text-sm h-20"
            placeholder={`Example:
Prospect: "Too expensive."
Me: I only compared price. They have a 2019 policy. I didn't unpack health changes or beneficiary risk.
Goal: Book a callback today.`}
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <button
            type="submit"
            disabled={sending}
            className="px-4 py-2 rounded bg-violet-600 text-white text-sm disabled:opacity-60"
          >
            {sending ? "Thinking…" : "Send"}
          </button>
        </div>
      </form>
    </div>
  );
}
