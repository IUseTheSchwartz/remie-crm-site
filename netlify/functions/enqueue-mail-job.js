import { createClient } from "@supabase/supabase-js";

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };
    const { lead_id, user_id, type = "welcome_policy_letter", payload = {} } = JSON.parse(event.body || "{}");
    if (!lead_id || !user_id) return { statusCode: 400, body: "Missing lead_id or user_id" };

    const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    const { data: lead, error: leadErr } = await admin
      .from("leads").select("id,user_id,status,sold").eq("id", lead_id).maybeSingle();
    if (leadErr) return { statusCode: 500, body: "Lead lookup error: " + leadErr.message };
    if (!lead) return { statusCode: 404, body: "Lead not found" };
    if (lead.user_id !== user_id) return { statusCode: 403, body: "Forbidden" };

    const { error } = await admin
      .from("mail_jobs")
      .insert([{ user_id, lead_id, type, payload, status: "queued" }]);
    if (error) return { statusCode: 500, body: "DB error: " + error.message };

    return { statusCode: 200, body: "queued" };
  } catch (e) {
    return { statusCode: 500, body: e?.message || "Server error" };
  }
}
