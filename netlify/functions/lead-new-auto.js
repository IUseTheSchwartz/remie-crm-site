// netlify/functions/lead-new-auto.js
// Sends the “new lead” text for a specific lead by calling the centralized
// messages-send function, so the attempt is always recorded in public.messages.

const { getServiceClient } = require("./_supabase.js");

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
  // supports:
  //  - mt.enabled === true/false
  //  - mt.enabled is an object like { new_lead: true, followup_2day: false }
  if (!mt) return false;
  if (typeof mt.enabled === "boolean") return mt.enabled;
  if (mt.enabled && typeof mt.enabled === "object") {
    if (typeof mt.enabled.new_lead === "boolean") return mt.enabled.new_lead;
  }
  // default to enabled if templates row exists but no flag present
  return true;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

    let p = {};
    try {
      p = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { error: "Invalid JSON body" });
    }

    const lead_id = p.lead_id || p.leadId;
    const requesterId = p.requesterId || p.user_id || p.userId;

    if (!lead_id || !requesterId) {
      return json(400, { error: "Missing required fields: lead_id and requesterId" });
    }

    // 1) Load the lead (and ensure it belongs to the requester)
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

    // 2) Load message templates/preferences for this user
    const { data: mt, error: tErr } = await supabase
      .from("message_templates")
      .select("*")
      .eq("user_id", requesterId)
      .maybeSingle();

    if (tErr) return json(500, { error: tErr.message });

    if (!mt || !isNewLeadEnabled(mt)) {
      return json(200, { ok: true, sent: false, reason: "template_disabled" });
    }

    // 3) Pick template (military vs default) and render
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
    if (!body) {
      return json(200, { ok: true, sent: false, reason: "empty_template" });
    }

    // 4) Call the centralized sender so it debits wallet + inserts a messages row
    const base = process.env.SITE_URL || process.env.URL;
    if (!base) return json(500, { error: "SITE_URL or URL must be configured" });

    let res;
    let out = {};
    try {
      res = await fetch(`${base}/.netlify/functions/messages-send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: lead.phone,
          body,
          lead_id: lead.id,
          requesterId,     // REQUIRED: binds messages.user_id to this user
          contact_id: null // optional; set if you track contact linkage
        }),
      });
      out = await res.json().catch(() => ({}));
    } catch (e) {
      return json(502, { ok: false, error: "messages-send unreachable", detail: e?.message });
    }

    if (!res.ok || out?.error) {
      return json(res.status, {
        ok: false,
        error: out?.error || "send_failed",
        telnyx_status: out?.telnyx_status,
        telnyx_response: out?.telnyx_response,
      });
    }

    // Success → messages row is already inserted by messages-send (status = queued initially)
    return json(200, { ok: true, sent: true, telnyx_id: out?.telnyx_id });
  } catch (e) {
    console.error("lead-new-auto error:", e);
    return json(500, { error: "Server error" });
  }
};
