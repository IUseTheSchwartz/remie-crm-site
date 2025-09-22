// File: netlify/functions/contacts-insert-smoke.js
// Try a minimal insert into message_contacts and return the exact DB error (if any).

const { getServiceClient } = require("./_supabase");

function json(body, status=200){
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  try {
    const db = getServiceClient();
    const project_ref = (process.env.SUPABASE_URL || "").match(/https?:\/\/([^.]+)\.supabase\.co/i)?.[1] || "unknown";

    const qs = event.queryStringParameters || {};
    const user_id = qs.user_id || null;
    const phone   = qs.phone   || null;
    const name    = qs.name    || "Smoke Test";
    const tag     = (qs.tag || "lead").toLowerCase();

    if (!user_id || !phone) {
      return json({ ok:false, error:"missing user_id or phone", example:"/.netlify/functions/contacts-insert-smoke?user_id=UUID&phone=+15555551234&name=Test&tag=lead" }, 400);
    }

    // Minimal payload; nothing fancy. This is exactly what your app needs to succeed.
    const payload = {
      user_id,
      phone,
      full_name: name,
      subscribed: true,
      tags: [tag],
      meta: {},
    };

    const { data, error } = await db
      .from("message_contacts")
      .insert([payload])
      .select("id, user_id, phone")
      .single();

    if (error) {
      // Surface the raw PostgREST/Postgres error so we can see triggers/RLS/operator issues.
      return json({
        ok: false,
        project_ref,
        payload,
        db_error: {
          message: error.message || String(error),
          details: error.details || null,
          hint: error.hint || null,
          code: error.code || null,
        },
      }, 200);
    }

    return json({ ok:true, project_ref, inserted: data }, 200);
  } catch (e) {
    return json({ ok:false, error:String(e?.message || e) }, 500);
  }
};
