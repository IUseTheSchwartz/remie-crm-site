// Groq via native fetch (no SDK required). Stateless + JSON output.
// Env: GROQ_API_KEY
const MODEL = "llama-3.1-8b-instant"; // swap to "llama-3.1-70b-versatile" for deeper coaching

const SYSTEM_PROMPT = `You are a high-performing US life-insurance sales manager coaching agents.

Core beliefs:
- Most objections are SMOKESCREENS: stalls, excuses, or avoidance of commitment.
- Your job is to help the agent regain call control, expose the real objection (trust/urgency/money/need), and redirect.
- Assume the prospect does need protection; resistance comes from fear, confusion, or budget.
- Be confident, directive, and realistic — what a top closer would actually say on the phone.
- Cut fluff. Short bullets. Punchy rebuttals. No essays.
- Never accept "send info" / "let me think" / "talk to spouse" at face value — pivot with control.
- Stay compliant: no false guarantees; emphasize risk, protection, and beneficiary needs. Mask any PII.

OUTPUT: ONLY valid JSON (no markdown, no prefix/suffix) with this schema:
{
  "why": string[],        // 3–5 blunt reasons the objection is a smokescreen or what truly went wrong
  "fix": string[],        // 3–5 specific tactics to regain control and move forward
  "rebuttals": string[]   // 2–3 punchy rebuttals (1–2 sentences each) suitable to SAY or TEXT
}
`;

function tryParseJSON(text) {
  // Handle accidental ```json fences or stray text
  let t = text.trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "").trim();
  }
  try { return JSON.parse(t); } catch { return null; }
}

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

Return ONLY JSON per the schema above. Keep bullets sharp and rebuttals punchy.`;

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
        temperature: 0.2,      // stricter, less rambly
        top_p: 0.9,
        max_tokens: 700,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error("Groq error:", resp.status, errText);
      return { statusCode: 500, body: "LLM error" };
    }

    const data = await resp.json();
    const raw = data?.choices?.[0]?.message?.content || "{}";

    let parsed = tryParseJSON(raw) || { why: [raw], fix: [], rebuttals: [] };

    // Final type safety
    const out = {
      why: Array.isArray(parsed.why) ? parsed.why.slice(0, 5) : [],
      fix: Array.isArray(parsed.fix) ? parsed.fix.slice(0, 5) : [],
      rebuttals: Array.isArray(parsed.rebuttals) ? parsed.rebuttals.slice(0, 3) : [],
    };

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(out),
    };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: "Server error" };
  }
};
