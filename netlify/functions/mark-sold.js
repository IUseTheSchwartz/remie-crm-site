// File: netlify/functions/mark-sold.js (CommonJS)
const { getServiceClient } = require("./_supabase.js");
const { sendSoldIfEnabled, toE164 } = require("./lib/messaging.js");
const supabase = getServiceClient();

module.exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

  try {
    const payload = JSON.parse(event.body || "{}");
    const {
      userId,
      leadId,
      name,
      phone,
      carrier,
      policy_number,
      premium,
      sendPolicyNow,
      optInBirthday,
      optInHoliday,
    } = payload;

    if (!userId || !phone) return { statusCode: 400, body: "userId and phone are required" };

    const normalized = toE164(phone);
    if (!normalized) return { statusCode: 400, body: "Invalid phone" };

    // (1) Update lead if present
    if (leadId) {
      await supabase
        .from("leads")
        .update({
          status: "sold",
          carrier,
          policy_number,
          premium,
          sold_at: new Date().toISOString(),
        })
        .eq("id", leadId);
    }

    // (2) Upsert contact + opt-ins
    const { data: existing } = await supabase
      .from("message_contacts")
      .select("id, meta, subscribed")
      .eq("user_id", userId)
      .eq("phone", normalized)
      .maybeSingle();

    if (existing) {
      await supabase
        .from("message_contacts")
        .update({
          full_name: name || undefined,
          meta: { ...(existing.meta || {}), birthday_opt_in: !!optInBirthday, holiday_opt_in: !!optInHoliday },
        })
        .eq("id", existing.id);
    } else {
      await supabase
        .from("message_contacts")
        .insert([{
          user_id: userId,
          full_name: name || "",
          phone: normalized,
          tags: ["sold"],
          meta: { birthday_opt_in: !!optInBirthday, holiday_opt_in: !!optInHoliday },
        }]);
    }

    // (3) Send policy info now if requested & enabled
    const { sent, reason } = await sendSoldIfEnabled({
      userId,
      leadId: leadId || null,
      sendNow: !!sendPolicyNow,
      lead: { name, phone: normalized, carrier, policy_number, premium },
    });

    return { statusCode: 200, body: JSON.stringify({ ok: true, sent, reason: sent ? undefined : reason }) };
  } catch (e) {
    console.error(e);
    return { statusCode: 500, body: e.message || "Internal Error" };
  }
};
