// netlify/functions/lead-new-auto.js
// Sends the “new lead” text for a specific lead by calling the centralized
// messages-send function IN-PROCESS (require + invoke), so the attempt is
// recorded in public.messages just like manual sends from the UI.

const { getServiceClient } = require("./_supabase.js");
// 👇 import the sibling function directly (avoids SITE_URL/URL issues)
const { handler: sendMessageHandler } = require("./messages-send.js");

const supabase = getServiceClient();

function json(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

const S = (x) => (x == null ? "" : String(x).trim());

// very small {{var}} renderer
function render(tpl, ctx) {
  return String(tpl || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, k) => S(ctx[k]));
}

function isNewLeadEnabled(mt) {
  if (!mt) return false;
  if (typeof mt.enabled === "boolean") return mt.enabled;
  if (mt.enabled && typeof mt.enabled === "object") {
    if (typeof mt.enabled.new_lead === "boolean") return mt.enabled.new_lead;
  }
  // If a templates row exists but no explicit flag, default to enabled
  return true;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

    let p = {};
    try { p = JSON.parse(event.body || "{}"); } catch { return json(400, { error: "Invalid JSON body" }); }

    const lead_id = p.lead_id || p.leadId;
    const requesterId = p.requesterId || p.user_id || p.userId;
    if (!lead_id || !requesterId) {
      return json(400, { error: "Missing required fields: lead_id and requesterId" });
    }

    // 1) Load the lead & ensure ownership
    const { data: lead, error: lErr } = await supabase
      .from("leads")
      .select("id, user_id, name, phone, state, beneficiary, beneficiary_name, military_branch")
      .eq("id", lead_id)
      .eq("user_id", requesterId)
      .maybeSingle();

    if (lErr) return json(500, { error: lErr.message });
    if (!lead) return json(404, { error: "Lead not found (or not owned by user)" });

    if (!S(lead.phone)) {
      return json(200, { ok: true, sent: false, reason: "missing_phone" });
    }

    // 2) Load message templates/prefs
    const { data: mt, error: tErr } = await supabase
      .from("message_templates")
      .select("*")
      .eq("user_id", requesterId)
      .maybeSingle();

    if (tErr) return json(500, { error: tErr.message });
    if (!mt || !isNewLeadEnabled(mt)) {
      return json(200, { ok: true, sent: false, reason: "template_disabled" });
    }

    // 3) Choose template and render
    const ctx = {
      name: lead.name || "",
      state: lead.state || "",
      beneficiary: lead.beneficiary || lead.beneficiary_name || "",
    };
    const hasBranch = !!S(lead.military_branch);
    const tpl = hasBranch
      ? (mt.templates?.new_lead_military || mt.new_lead_military || mt.templates?.new_lead || mt.new_lead || "")
      : (mt.templates?.new_lead || mt.new_lead || "");

    const body = render(tpl, ctx).trim();
    if (!body) return json(200, { ok: true, sent: false, reason: "empty_template" });

    // 4) Call messages-send IN-PROCESS so it inserts into public.messages
    const fakeEvent = {
      httpMethod: "POST",
      body: JSON.stringify({
        to: lead.phone,
        body,
        lead_id: lead.id,
        requesterId,     // ensures messages.user_id is set to this user
        contact_id: null // optional: set if you track linkage
      }),
    };

    const sendRes = await sendMessageHandler(fakeEvent);
    let out = {};
    try { out = JSON.parse(sendRes.body || "{}"); } catch { out = {}; }

    if (sendRes.statusCode >= 400 || out?.error) {
      return json(sendRes.statusCode, {
        ok: false,
        error: out?.error || "send_failed",
        telnyx_status: out?.telnyx_status,
        telnyx_response: out?.telnyx_response,
        // messages-send also inserts a 'failed' row; UI should still see it
      });
    }

    // Success → messages-send already wrote the 'queued' row
    return json(200, { ok: true, sent: true, telnyx_id: out?.telnyx_id });
  } catch (e) {
    console.error("lead-new-auto error:", e);
    return json(500, { error: "Server error" });
  }
};
