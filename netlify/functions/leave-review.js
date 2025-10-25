// File: netlify/functions/leave-review.js
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL =
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE; // service-role key in Netlify env

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false },
});

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  // Optional CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
      body: "",
    };
  }

  if (event.httpMethod !== "POST") {
    return json(405, { ok: false, error: "Method not allowed" });
  }

  let payload = {};
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { ok: false, error: "Invalid JSON" });
  }

  try {
    const { agent_id, rating, reviewer_name, comment } = payload || {};
    const r = Number(rating);

    if (!agent_id || !Number.isFinite(r) || r < 1 || r > 5) {
      return json(400, { ok: false, error: "Invalid input" });
    }

    const safeName =
      reviewer_name && String(reviewer_name).trim()
        ? String(reviewer_name).trim().slice(0, 80)
        : null;
    const safeComment =
      comment && String(comment).trim()
        ? String(comment).trim().slice(0, 280)
        : "";

    const { error } = await supabase.from("agent_reviews").insert({
      agent_id,
      rating: r,
      reviewer_name: safeName,
      comment: safeComment,
      // 🔥 Make public immediately
      is_public: true,
    });

    if (error) {
      console.error("leave-review insert error:", error);
      return json(500, { ok: false, error: "Insert failed" });
    }

    return json(200, { ok: true });
  } catch (e) {
    console.error("leave-review server error:", e);
    return json(500, { ok: false, error: "Server error" });
  }
};
