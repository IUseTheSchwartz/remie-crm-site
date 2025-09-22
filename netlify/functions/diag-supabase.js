// Returns server-side Supabase project ref, URL, and a quick count from message_contacts for the user
const { getServiceClient } = require("./_supabase");

function json(body, status=200){ return { statusCode: status, headers: { "Content-Type":"application/json" }, body: JSON.stringify(body) }; }

exports.handler = async (event) => {
  try {
    const db = getServiceClient(); // MUST use SERVICE ROLE envs
    const project_ref = (process.env.SUPABASE_URL||"").match(/https?:\/\/([^.]+)\.supabase\.co/i)?.[1] || "unknown";

    // Try to infer user_id from a query param for quick testing (or hardcode yours temporarily)
    const user_id = (event.queryStringParameters && event.queryStringParameters.user_id) || null;

    let rowCount = null;
    let errMsg = null;

    if (user_id) {
      const { count, error } = await db
        .from("message_contacts")
        .select("*", { count: "exact", head: true })
        .eq("user_id", user_id);
      if (error) errMsg = String(error.message || error);
      rowCount = count ?? null;
    }

    return json({
      ok: true,
      server: {
        supabase_url: process.env.SUPABASE_URL || null,
        project_ref,
        has_service_role: !!(process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY),
        message_contacts_count_for_user: rowCount,
        error: errMsg
      }
    });
  } catch (e) {
    return json({ ok: false, error: String(e?.message || e) }, 500);
  }
};
