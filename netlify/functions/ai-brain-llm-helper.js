// File: netlify/functions/ai-brain-llm-helper.js
// Classifies a raw SMS into { intent, lang, time: {type,value}, confidence } using Groq,
// and (optionally) generates a SHORT LLM reply for non-preset/unique messages.
// Never put long copy logic here — ai-brain.js is the planner that decides when to call this.

const API = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = process.env.GROQ_MODEL || "llama-3.1-8b-instant";

/* =========================
   Intent Classifier
   ========================= */
const INTENTS = new Set([
  "who","price","callme","time_specific","time_window",
  "covered","brushoff","spouse","wrong","agree","greet","general",
  "info","cant_talk","how_long","verify","reschedule"
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
    "Return STRICT JSON only. Schema:",
    "{",
    '  "intent": "who|price|callme|time_specific|time_window|covered|brushoff|spouse|wrong|agree|greet|general|info|cant_talk|how_long|verify|reschedule",',
    '  "lang": "en|es",',
    '  "time": {"type": "specific|window|none", "value": "10:30 AM|morning|after 3|"},',
    '  "confidence": 0.0-1.0',
    "}",
    "For times, use 'specific' only for explicit clock times (e.g., '10am').",
    "Examples like 'after 3', 'morning' => time_window.",
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

/* =========================
   Short Reply Generator
   ========================= */
async function llmReply(
  {
    text,
    language = "en",
    calendlyLink = "",   // in our setup this is the agent-site link (brand-safe)
    agentName = "your licensed broker",
    context = {},
    maxTokens = Number(process.env.AI_BRAIN_LLM_REPLY_MAXTOKENS || 140)
  } = {}
) {
  if (!process.env.GROQ_API_KEY) {
    return { text: "", confidence: 0, reasons: ["no_api_key"] };
  }

  // Guardrails: keep it brief, human, and *do not* schedule on your own.
  // The planner (ai-brain.js) handles time parsing/confirmation.
  const es = /es/i.test(language);
  const linkNote = calendlyLink ? (
    es
      ? ` En caso de duda, puede verificar mis credenciales aquí: ${calendlyLink}`
      : ` If you’d like to verify my credentials, here’s my website: ${calendlyLink}`
  ) : "";

  const sys = [
    "You are a friendly, concise SMS assistant for a licensed life-insurance broker.",
    "GOALS:",
    "1) Acknowledge what the user said.",
    "2) If they’re asking for quotes/prices/info, briefly set expectation that a short call confirms details (health/beneficiary) to give exact numbers.",
    "3) Ask ONE simple follow-up or next step question when helpful.",
    "4) Keep it human; avoid robotic phrasing. No emojis.",
    "HARD RULES:",
    "- 1–2 sentences max (strict).",
    "- Do not invent times or confirm appointments yourself.",
    "- Do not include links unless one was provided in the tool input.",
    "- No legal/medical advice.",
    "- Stay neutral/professional; avoid pushiness.",
    `- If a verification link is provided, you may include AT MOST one short clause referencing it.${calendlyLink ? " A SINGLE short clause is allowed." : ""}`,
    "OUTPUT: return STRICT JSON with keys: {\"text\": string, \"confidence\": 0..1, \"reasons\": string[] }",
  ].join("\n");

  const user = [
    es
      ? `Lead message (Spanish=${es}): "${String(text || "").slice(0, 400)}".`
      : `Lead message: "${String(text || "").slice(0, 400)}".`,
    `Agent name: ${agentName}.`,
    calendlyLink ? `Verification website: ${calendlyLink}.` : "No website provided.",
    context?.last_intent ? `Recent context intent: ${context.last_intent}.` : "No prior context.",
    "Remember: 1–2 sentences total.",
  ].join("\n");

  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), 12000);

  try {
    const r = await fetch(API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.3,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: sys },
          { role: "user", content: user },
        ],
        max_tokens: Math.max(64, Math.min(256, maxTokens)),
      }),
      signal: ctrl.signal,
    });

    const j = await r.json().catch(() => ({}));
    const raw = j?.choices?.[0]?.message?.content || "{}";
    const parsed = jsonParseLoose(raw) || {};
    let outText = String(parsed.text || "").trim();

    // Post-process: if model forgot the website line but it’s allowed and helpful, add a *short* clause at end.
    if (outText && calendlyLink) {
      const lower = outText.toLowerCase();
      const alreadyHasLink = lower.includes("http://") || lower.includes("https://");
      const mentionsVerify = /verify|credentials|sitio|credenciales/i.test(outText);
      if (!alreadyHasLink && mentionsVerify) {
        outText = outText + (es
          ? ` Puede verificar mis credenciales aquí: ${calendlyLink}`
          : ` You can verify my credentials here: ${calendlyLink}`);
      }
    }

    // Enforce 1–2 sentences max (very light heuristic)
    const sentences = outText.split(/(?<=[.!?])\s+/).filter(Boolean);
    if (sentences.length > 2) outText = sentences.slice(0, 2).join(" ");

    return {
      text: outText,
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence || 0.6))),
      reasons: Array.isArray(parsed.reasons) ? parsed.reasons.slice(0, 4) : []
    };
  } catch (e) {
    return { text: "", confidence: 0, reasons: ["request_error"] };
  } finally {
    clearTimeout(id);
  }
}

module.exports = { llmClassify, llmReply };
