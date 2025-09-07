// Uses Groq (no storage, no streaming). Returns plain text to the client.
// If your package.json does NOT have "type":"module", use this CommonJS version.

const Groq = require("groq-sdk");
const client = new Groq({ apiKey: process.env.GROQ_API_KEY });

// fast: "llama-3.1-8b-instant" | higher quality: "llama-3.1-70b-versatile"
const MODEL = "llama-3.1-8b-instant";

const SYSTEM_PROMPT = `You are a US life-insurance sales coach (Final Expense, Term, IUL, Whole Life).
- Be concise, practical, and compliant (no guarantees unless true; no misleading claims).
- Focus on discovery (health, budget, beneficiary risk), value framing, call control, soft closes.
- Mask any PII present (don't echo phone, SSN, DOB).
Return three sections:
1) What likely went wrong (3–6 bullets)
2) How to fix it next time (3–6 bullets)
3) 2–3 short rebuttals (1–3 sentences each)`;

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "Method not allowed" };
    }

    const { content = "", product = "Final Expense", tone = "Direct & supportive" } =
      JSON.parse(event.body || "{}");
    if (content.trim().length < 4) {
      return { statusCode: 400, body: "Please provide a short description of what happened." };
    }

    const userPrompt = `Agent context:
- Product: ${product}
- Coaching tone: ${tone}

Call summary / objection:
${content.trim()}

Task: Provide the 3 sections described in the system message. Keep it tight and immediately actionable.`;

    const resp = await client.chat.completions.create({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.4,
    });

    const text = resp.choices?.[0]?.message?.content?.trim() || "No response.";
    return {
      statusCode: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: text,
    };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: "Server error" };
  }
};
