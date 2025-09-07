/**
 * Rebuttal coach (stateless) using Groq SDK.
 * - Smokescreen-aware manager tone
 * - Strict JSON output: { why[], fix[], rebuttals[] }
 * - No DB writes, no logging
 *
 * Env required:
 *   GROQ_API_KEY = gsk_...
 *
 * Notes:
 * - Uses CommonJS `exports.handler` to match the rest of your functions.
 * - If your site switches to "type":"module", I can send an ESM version.
 */

const Groq = require("groq-sdk");
const client = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Fast default; switch to 70B for deeper answers
const DEFAULT_MODEL = "llama-3.1-8b-instant";
// const DEFAULT_MODEL = "llama-3.1-70b-versatile";

const SYSTEM_PROMPT = `You are a high-performing US life-insurance sales manager coaching agents.

Core beliefs:
- Most objections are SMOKESCREENS: stalls, excuses, or avoidance of commitment.
- Your job is to help the agent regain call control, expose the real objection (trust/urgency/money/need), and redirect.
- Assume the prospect does need protection; resistance comes from fear, confusion, or budget.
- Be confident, directive, and realistic — what a top closer would actually say on the phone.
- Cut fluff. Short bullets. Punchy rebuttals. No essays.
- Never accept "send info" / "let me think" / "talk to spouse" at face value — pivot with control.
- Stay compliant: no false guarantees; emphasize risk, protection, and beneficiary needs. Mask any PII.

OUTPUT: ONLY valid JSON (no markdown, no preface) with schema:
{
  "why": string[],        // 3–5 blunt reasons the objection is a smokescreen or what truly went wrong
  "fix": string[],        // 3–5 specific tactics to regain control and move forward
  "rebuttals": string[]   // 2–3 punchy rebuttals (1–2 sentences each) suitable to SAY or TEXT
}
`;

// Strip accidental code fences if the model adds them
function tryParseJSON(text) {
  let t = (text || "").trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```json/i, "")
         .replace(/^```/, "")
         .replace(/```$/, "")
         .trim();
  }
  try { return JSON.parse(t); } catch { return null; }
}

// Basic CORS helper (optional; safe defaults)
function withCors(res) {
  res.headers = {
    ...(res.headers || {}),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
  return res;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") {
      return withCors({ statusCode: 204, body: "" });
    }
    if (event.httpMethod !== "POST") {
      return withCors({ statusCode: 405, body: "Method not allowed" });
    }

    const { content = "", product = "Final Expense", tone = "Direct & supportive", model } =
      JSON.parse(event.body || "{}");

    if (typeof content !== "string" || content.trim().length < 4) {
      return withCors({ statusCode: 400, body: "Please provide a short description of what happened." });
    }

    const userPrompt = `Agent context:
- Product: ${product}
- Coaching tone: ${tone}

Call summary / objection:
${content.trim()}

Return ONLY JSON per the schema above. Keep bullets sharp and rebuttals punchy.`;

    // Call Groq (Chat Completions)
    const resp = await client.chat.completions.create({
      model: model || DEFAULT_MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      // tighter output, less rambling
      temperature: 0.2,
      top_p: 0.9,
      max_tokens: 700,
    });

    const raw = resp?.choices?.[0]?.message?.content || "{}";
    let parsed = tryParseJSON(raw) || { why: [raw], fix: [], rebuttals: [] };

    // Final safety + trimming
    const out = {
      why: Array.isArray(parsed.why) ? parsed.why.slice(0, 5) : [],
      fix: Array.isArray(parsed.fix) ? parsed.fix.slice(0, 5) : [],
      rebuttals: Array.isArray(parsed.rebuttals) ? parsed.rebuttals.slice(0, 3) : [],
    };

    return withCors({
      statusCode: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(out),
    });
  } catch (err) {
    console.error("rebuttal-chat error:", err);
    return withCors({ statusCode: 500, body: "Server error" });
  }
};
