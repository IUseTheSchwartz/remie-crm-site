// netlify/functions/zap-webhook.js
// Purpose: receive Zapier POSTs and create a lead, update contact tags,
// and trigger your existing new-lead auto-text flow.
// Auth: Basic Auth (username = webhook id, password = secret).

const { getServiceClient } = require("./_supabase");
const supabase = getServiceClient();

// Helpers
const S = (v) => (v == null ? "" : typeof v === "string" ? v.trim() : String(v).trim());
const U = (v) => { const s = S(v); return s === "" ? undefined : s; };

function onlyDigits(s){return String(s||"").replace(/\D/g,"");}
function normalizePhone(s){const d=onlyDigits(s); return d.length===11&&d.startsWith("1")?d.slice(1):d;}
function toE164(s){const d=onlyDigits(s); if(!d) return null; if(d.length===11&&d.startsWith("1"))return `+${d}`; if(d.length===10)return `+1${d}`; return s&&s.startsWith("+")?s:null; }

function getAuthHeader(event) {
  const h = event.headers || {};
  return h.authorization || h.Authorization || "";
}

// contact tag helper
async function computeNextContactTags({ supabase, user_id, phone, full_name, military_branch }) {
  const phoneNorm = normalizePhone(phone);
  const { data: candidates } = await supabase
    .from("message_contacts")
    .select("id, phone, tags")
    .eq("user_id", user_id);

  const found = (candidates || []).find((c) => normalizePhone(c.phone) === phoneNorm);
  const current = Array.isArray(found?.tags) ? found.tags : [];
  const withoutStatus = current.filter((t) => !["lead", "military"].includes(String(t).toLowerCase()));
  const status = (S(military_branch) ? "military" : "lead");
  const next = Array.from(new Set([...withoutStatus, status]));
  return { contactId: found?.id ?? null, tags: next };
}

async function upsertContact(supabase, { user_id, phone, full_name, tags, meta = {} }) {
  const phoneE164 = toE164(phone) || phone;
  const { data: existing } = await supabase
    .from("message_contacts")
    .select("id, meta, full_name")
    .eq("user_id", user_id)
    .eq("phone", phoneE164)
    .maybeSingle();

  if (existing?.id) {
    const mergedMeta = { ...(existing.meta || {}), ...(meta || {}) };
    await supabase
      .from("message_contacts")
      .update({ full_name: full_name || existing.full_name, tags, meta: mergedMeta })
      .eq("id", existing.id);
    return existing.id;
  } else {
    const { data: ins } = await supabase
      .from("message_contacts")
      .insert([{ user_id, phone: phoneE164, full_name, tags, meta, subscribed: true }])
      .select("id")
      .single();
    return ins.id;
  }
}

// auto-text sender
const { handler: sendMessage } = require("./messages-send");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

  try {
    // --- Basic Auth ---
    const auth = getAuthHeader(event);
    if (!auth.startsWith("Basic ")) return { statusCode: 401, body: "Missing Basic Auth" };
    const [id, secret] = Buffer.from(auth.slice(6), "base64").toString("utf8").split(":");

    if (!id || !secret) return { statusCode: 401, body: "Invalid Basic Auth" };

    const { data: rows } = await supabase
      .from("user_inbound_webhooks")
      .select("id, user_id, secret, active")
      .eq("id", id)
      .eq("active", true)
      .limit(1);

    const wh = rows?.[0];
    if (!wh || wh.secret !== secret) return { statusCode: 403, body: "Forbidden" };

    // --- Parse JSON body ---
    let p; try { p = JSON.parse(event.body || "{}"); } catch { return { statusCode: 400, body: "Invalid JSON" }; }

    const nowIso = new Date().toISOString();
    const lead = {
      user_id: wh.user_id,
      name: U(p.name) || null,
      phone: U(p.phone) || null,
      email: U(p.email) || null,
      state: U(p.state) || null,
      created_at: nowIso,
      stage: "no_pickup",
      stage_changed_at: nowIso,
      priority: "medium",
      call_attempts: 0,
      last_outcome: "",
      pipeline: {},
      military_branch: U(p.military_branch) || null,
      beneficiary: U(p.beneficiary),
      beneficiary_name: U(p.beneficiary_name),
      notes: U(p.notes),
    };

    if (!lead.phone && !lead.email) {
      return { statusCode: 400, body: "Lead missing phone/email" };
    }

    const { data: inserted, error: insErr } = await supabase
      .from("leads")
      .insert([lead])
      .select("id")
      .single();
    if (insErr) return { statusCode: 500, body: insErr.message };

    const leadId = inserted.id;

    // --- Upsert contact ---
    let contactId = null;
    if (lead.phone) {
      const { tags } = await computeNextContactTags({
        supabase,
        user_id: wh.user_id,
        phone: lead.phone,
        full_name: lead.name,
        military_branch: lead.military_branch,
      });
      contactId = await upsertContact(supabase, {
        user_id: wh.user_id,
        phone: lead.phone,
        full_name: lead.name,
        tags,
        meta: { lead_id: leadId, beneficiary: lead.beneficiary_name || lead.beneficiary },
      });
    }

    // --- Auto send new lead text ---
    await sendMessage({
      body: JSON.stringify({
        lead_id: leadId,
        contact_id: contactId,
        templateKey: lead.military_branch ? "new_lead_military" : "new_lead",
        requesterId: wh.user_id,
        provider_message_id: `lead:${leadId}`,
      }),
    });

    return { statusCode: 200, body: JSON.stringify({ ok: true, id: leadId }) };
  } catch (e) {
    console.error("[zap-webhook]", e);
    return { statusCode: 500, body: "Server error" };
  }
};
