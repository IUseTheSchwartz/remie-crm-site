// File: netlify/functions/lead-new-auto.js
const { getServiceClient } = require("./_supabase.js");
const { sendNewLeadIfEnabled } = require("./lib/messaging.js");

const supabase = getServiceClient();

function json(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

/**
 * POST /.netlify/functions/lead-new-auto
 * Body: { lead_id: string, requesterId: string }
 *
 * Looks up the lead (must belong to requesterId) and triggers sendNewLeadIfEnabled.
 */
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  let p = {};
  try {
    p = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Invalid JSON" });
  }

  const { lead_id, requesterId } = p || {};
  if (!lead_id || !requesterId) {
    return json(400, { error: "Missing lead_id or requesterId" });
  }

  try {
    // Ensure the lead belongs to this user
    const { data: lead, error } = await supabase
      .from("leads")
      .select("id, user_id, name, phone, state, beneficiary, military_branch")
      .eq("id", lead_id)
      .eq("user_id", requesterId)
      .maybeSingle();

    if (error) return json(500, { error: error.message });
    if (!lead) return json(404, { error: "Lead not found or not owned by user" });

    // Fire the same flow used by the Sheets webhook
    const res = await sendNewLeadIfEnabled({
      userId: requesterId,
      leadId: lead.id,
      lead: {
        name: lead.name,
        phone: lead.phone,
        state: lead.state,
        beneficiary: lead.beneficiary,
        military_branch: lead.military_branch,
      },
    });

    // res: { sent: boolean, reason?: string }
    return json(200, { ok: true, ...res });
  } catch (e) {
    console.error("lead-new-auto error:", e);
    return json(500, { error: e?.message || "Server error" });
  }
};
