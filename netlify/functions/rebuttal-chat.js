// Classic Netlify Function (CommonJS) — no storage, no streaming.
const OpenAI = require("openai");
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM_PROMPT = `You are a life-insurance sales coach (Final Expense, Term, IUL, Whole Life) for US consumers.
- Be concise, practical, and compliant (no guarantees unless true; avoid misleading claims).
- Prioritize: discovery (health, budget, beneficiary risk), value framing, call control, soft closes.
- Never echo sensitive PII verbatim (mask if present).
- Your response should include:
  1) What likely went wrong (3–6 bullets).
  2) How to fix it next time (3–6 bullets).
  3) 2–3 short rebuttals (1–3 sentences each) the agent can say or text.
- Style depends on the chosen tone (direct & supportive by default).`;

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "Method not allowed" };
    }

    const { content = "", product = "Final Expense", tone = "Direct & supportive" } =
      JSON.parse(event.body || "{}");

    if (typeof content !== "string" || content.trim().length < 4) {
      return { statusCode: 400, body: "Please provide a short description of what happened." };
    }

    const userPrompt = `Agent context:
- Product: ${product}
- Coaching tone: ${tone}

Call summary / objection:
${content.trim()}

Task: Provide the 3 sections described in the system message. Keep it tight and immediately actionable.`;

    const response = await client.responses.create({
      model: "gpt-4o-mini",
      input: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
    });

    const text = response.output_text || "No response text.";
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
