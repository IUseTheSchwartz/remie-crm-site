// File: netlify/functions/assign-tfn.js
const { getServiceClient } = require("./_supabase");

exports.handler = async (event) => {
  try {
    const db = getServiceClient();
    const { user_id, e164 } = JSON.parse(event.body || "{}");

    if (!user_id || !e164) {
      return { statusCode: 400, body: JSON.stringify({ error: "missing user_id or e164" }) };
    }

    // deactivate old numbers
    await db.from("agent_messaging_numbers")
      .update({ status: "inactive" })
      .eq("user_id", user_id);

    // upsert new
    const { error } = await db.from("agent_messaging_numbers").upsert({
      user_id,
      e164,
      status: "active",
    });
    if (error) throw error;

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    console.error(e);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
