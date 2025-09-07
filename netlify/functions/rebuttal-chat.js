// Calls Groq and RETURNS JSON so the UI can render cleanly.
// Env: GROQ_API_KEY
const MODEL = "llama-3.1-8b-instant"; // swap to "llama-3.1-70b-versatile" for deeper coaching

const SYSTEM_PROMPT = `You are a US life-insurance sales coach (Final Expense, Term, IUL, Whole Life).
- Be concise, compliant (no guarantees unless true; no misleading claims).
- Focus on discovery (health, budget, beneficiary risk), value framing, call control, soft closes.
- If input contains PII, do not repeat it verbatim (mask it).
- IMPORTANT: Output ONLY valid JSON, no markdown, no commentary.
- JSON schema:
{
  "why": string[],        // 3-6 short bullet points
  "fix": string[],        // 3-6 short bullet points
  "rebuttals": string[]   // 2-3 short lines (1-3 sentences each)
}`;

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "Method not allowed" };
    }

    const { content = "", product = "Final Expense", tone = "Direct & supportive", model } =
      JSON.parse(event.body || "{}");
    if (content.trim().length < 4) {
      return { statusCode: 400, body: "Please provide a short description of what happened." };
    }

    const userPrompt = `Agent context:
- Product: ${product}
- Coaching tone: ${tone}

Call summary / objection:
${content.trim()}

Return ONLY JSON per the schema.`;

    const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: model || MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.2, // tighter, less rambly
        max_tokens: 600,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error("Groq error:", resp.status, errText);
      return { statusCode: 500, body: "LLM error" };
    }

    const data = await resp.json();
    const raw = data?.choices?.[0]?.message?.content || "{}";

    // Try to parse model output as JSON
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (e) {
      // Fallback: wrap as arrays if it returned plain text
      parsed = { why: [raw], fix: [], rebuttals: [] };
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        why: Array.isArray(parsed.why) ? parsed.why : [],
        fix: Array.isArray(parsed.fix) ? parsed.fix : [],
        rebuttals: Array.isArray(parsed.rebuttals) ? parsed.rebuttals : [],
      }),
    };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: "Server error" };
  }
};
