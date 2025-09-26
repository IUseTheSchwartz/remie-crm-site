// File: netlify/functions/assign-tfn.js
const { getServiceClient } = require("./_supabase");

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "Method Not Allowed" };
    }
    const db = getServiceClient();

    const body = JSON.parse(event.body || "{}");
    const { user_id, telnyx_phone_id, e164, telnyx_messaging_profile_id } = body || {};

    if (!user_id || !telnyx_phone_id || !e164) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "missing user_id or telnyx_phone_id or e164" }),
      };
    }

    // Deactivate any previous numbers for this user
    await db
      .from("agent_messaging_numbers")
      .update({ status: "suspended" })
      .eq("user_id", user_id);

    // Upsert the picked number as active
    const upsertRow = {
      user_id,
      e164,
      telnyx_phone_id,
      telnyx_messaging_profile_id: telnyx_messaging_profile_id || null,
      status: "active",
      verified_at: new Date().toISOString(), // mark as verified since it’s already on your account
    };

    const { error } = await db
      .from("agent_messaging_numbers")
      .upsert(upsertRow, { onConflict: "e164" });

    if (error) {
      return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    console.error(e);
    return { statusCode: 500, body: JSON.stringify({ error: e.message || String(e) }) };
  }
};
