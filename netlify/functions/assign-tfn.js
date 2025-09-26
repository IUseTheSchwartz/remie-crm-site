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
      return { statusCode: 400, body: JSON.stringify({ error: "missing user_id or telnyx_phone_id or e164" }) };
    }

    // 0) Guard: number already assigned to another user?
    const { data: existingActive, error: exErr } = await db
      .from("agent_messaging_numbers")
      .select("user_id, status")
      .eq("e164", e164)
      .eq("status", "active")
      .maybeSingle();

    if (exErr) {
      return { statusCode: 500, body: JSON.stringify({ error: exErr.message }) };
    }
    if (existingActive && existingActive.user_id !== user_id) {
      return { statusCode: 409, body: JSON.stringify({ error: "number_already_assigned" }) };
    }

    // 1) Deactivate current active for this user
    const { error: deErr } = await db
      .from("agent_messaging_numbers")
      .update({ status: "suspended" })
      .eq("user_id", user_id)
      .eq("status", "active");
    if (deErr) {
      return { statusCode: 500, body: JSON.stringify({ error: deErr.message }) };
    }

    // 2) Upsert this TFN as active
    const upsertRow = {
      user_id,
      e164,
      telnyx_phone_id,
      telnyx_messaging_profile_id: telnyx_messaging_profile_id || null,
      status: "active",
      verified_at: new Date().toISOString(),
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