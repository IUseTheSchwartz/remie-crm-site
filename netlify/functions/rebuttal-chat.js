// netlify/functions/rebuttal-chat.js
// Stateless streaming chat for life-insurance rebuttal coaching.
// No Supabase. No logging. Just stream tokens back to the client.

import OpenAI from "openai";

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

export default async (req, res) => {
  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end("Method not allowed");
  }

  try {
    const body = await req.json();
    const { content = "", product = "Final Expense", tone = "Direct & supportive" } = body;

    if (typeof content !== "string" || content.trim().length < 4) {
      res.statusCode = 400;
      return res.end("Please provide a short description of what happened.");
    }

    // Prepare a compact instruction for the model
    const userPrompt = `Agent context:
- Product: ${product}
- Coaching tone: ${tone}

Call summary / objection:
${content.trim()}

Task: Provide the 3 sections described in the system message. Keep it tight and immediately actionable.`;

    // Use the Responses API with streaming for low-latency typing effect
    const stream = await client.responses.stream({
      model: "gpt-4o-mini",
      input: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
    });

    // Set streaming headers
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Transfer-Encoding", "chunked");

    stream.on("message", (msg) => {
      const text = msg?.output_text ?? "";
      if (text) res.write(text);
    });

    stream.on("end", () => {
      res.end();
    });

    stream.on("error", (err) => {
      console.error(err);
      if (!res.writableEnded) {
        res.statusCode = 500;
        res.end("Error");
      }
    });

    // Start the stream
    await stream.finalMessage();
  } catch (err) {
    console.error(err);
    res.statusCode = 500;
    res.end("Server error");
  }
};
