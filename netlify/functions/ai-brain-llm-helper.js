// File: netlify/functions/ai-brain-llm-helper.js
// Classifies a raw SMS into { intent, lang, time: {type,value}, confidence } using Groq.
// Never generate reply copy here—templates live in ai-brain.js.

const API = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = process.env.GROQ_MODEL || "llama-3.1-8b-instant";
const INTENTS = new Set([
  "who","price","callme","time_specific","time_window",
  "covered","brushoff","spouse","wrong","agree","greet","general"
]);

function clampIntent(s) {
  s = String(s || "").toLowerCase().trim();
  return INTENTS.has(s) ? s : "general";
}

function jsonParseLoose(s) {
  try { return JSON.parse(s); } catch {}
  const i = s.indexOf("{"), j = s.lastIndexOf("}");
  if (i >= 0 && j > i) { try { return JSON.parse(s.slice(i, j + 1)); } catch {} }
  return null;
}

async function llmClassify(text, { timeoutMs = 12000 } = {}) {
  if (!process.env.GROQ_API_KEY) {
    return { intent: "general", lang: "en", time: { type: "none", value: "" }, confidence: 0 };
  }

  const sys = [
    "You label a single inbound SMS from a U.S. consumer.",
    "Return STRICT JSON only. No prose. Schema:",
    "{",
    '  "intent": "who|price|callme|time_specific|time_window|covered|brushoff|spouse|wrong|agree|greet|general",',
    '  "lang": "en|es",',
    '  "time": {"type": "specific|window|none", "value": "10:30 AM|morning|after 3|"},',
    '  "confidence": 0.0-1.0',
    "}",
    "For times, extract user’s best hint. Use 'specific' only if an actual clock time is given (e.g., '10am', '10:30').",
    "If user says 'after 3', 'morning', 'evening', classify as time_window and set value accordingly.",
  ].join("\n");

  const user = `Text: "${String(text || "").slice(0, 500)}"`;

  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [{ role: "system", content: sys }, { role: "user", content: user }],
      }),
      signal: ctrl.signal,
    });
    const j = await r.json().catch(() => ({}));
    const raw = j?.choices?.[0]?.message?.content || "{}";
    const parsed = jsonParseLoose(raw) || {};
    const out = {
      intent: clampIntent(parsed.intent),
      lang: /es/i.test(parsed.lang) ? "es" : "en",
      time: parsed.time && typeof parsed.time === "object"
        ? { type: parsed.time.type || "none", value: parsed.time.value || "" }
        : { type: "none", value: "" },
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence || 0))),
    };
    return out;
  } catch (e) {
    return { intent: "general", lang: "en", time: { type: "none", value: "" }, confidence: 0 };
  } finally {
    clearTimeout(id);
  }
}

module.exports = { llmClassify };
