// netlify/functions/numbers-list.js
const { supaAdmin } = require("./_supa");

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") return { statusCode: 405, body: "Method Not Allowed" };
  const qs = new URLSearchParams(event.queryStringParameters || {});
  const agent_id = qs.get("agent_id");
  if (!agent_id) return { statusCode: 400, body: "agent_id required" };

  const supa = supaAdmin();
  const { data, error } = await supa
    .from("agent_numbers")
    .select("*")
    .eq("agent_id", agent_id)
    .order("purchased_at", { ascending: false });

  if (error) return { statusCode: 500, body: error.message };
  return { statusCode: 200, body: JSON.stringify({ ok: true, numbers: data || [] }) };
};
