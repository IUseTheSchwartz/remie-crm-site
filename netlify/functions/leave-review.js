// File: netlify/functions/leave-review.js
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE; // set in Netlify env

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false },
});

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const { agent_id, rating, reviewer_name, comment } = req.body || {};
    const r = Number(rating);
    if (!agent_id || !Number.isFinite(r) || r < 1 || r > 5) {
      return res.status(400).json({ ok: false, error: "Invalid input" });
    }

    // Insert hidden; you’ll approve in the CRM
    const { error } = await supabase.from("agent_reviews").insert({
      agent_id,
      rating: r,
      reviewer_name: reviewer_name ? String(reviewer_name).slice(0, 80) : null,
      comment: comment ? String(comment).slice(0, 280) : "",
      is_public: false,
    });
    if (error) {
      console.error(error);
      return res.status(500).json({ ok: false, error: "Insert failed" });
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}
