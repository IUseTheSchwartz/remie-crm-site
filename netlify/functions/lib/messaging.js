// File: netlify/functions/lib/messaging.js (CommonJS)
const fetch = global.fetch || ((...a) => import('node-fetch').then(({default: f}) => f(...a)));
const { getServiceClient } = require("../_supabase.js"); // ← reuse your existing helper
const supabase = getServiceClient();

const DEFAULTS = {
  new_lead:
    "Hi {{first_name}}, this is {{agent_name}}, a licensed life insurance broker in {{state}}. I just received the form you sent in to my office where you listed {{beneficiary}} as the beneficiary. If I’m unable to reach you or there’s a better time to get back to you, feel free to book an appointment with me here: {{calendly_link}} You can text me anytime at {{agent_phone}} (this business text line doesn’t accept calls).",
  new_lead_military:
    "Hello {{first_name}}, this is {{agent_name}}, a licensed life insurance broker. I see you noted {{beneficiary}} as your beneficiary and your background with the {{military_branch}}. I handle coverage for service members and veterans directly. Let’s connect today to review your options and make sure everything is squared away. You can also set a time here: {{calendly_link}}. Text me at {{agent_phone}} (this business text line doesn’t accept calls).",
  sold:
    "Hi {{first_name}}, this is {{agent_name}}. Congratulations on getting approved! 🎉 Here are the details of your new policy:\n• Carrier: {{carrier}}\n• Policy #: {{policy_number}}\n• Premium: ${{premium}}/mo\nIf you have any questions or need assistance, feel free to reach out by text. You can text me at {{agent_phone}} (this business text line doesn’t accept calls).",
  birthday_text:
    "Hi {{first_name}}, this is {{agent_name}}. Happy Birthday! 🎉 Wishing you a wonderful year ahead. If you need anything, text me at {{agent_phone}}.",
  holiday_text:
    "Hi {{first_name}}, this is {{agent_name}}. Wishing you and your family a happy holiday! If you need anything related to your coverage, I’m here. Text me at {{agent_phone}}.",
};

function renderTemplate(tpl, ctx) {
  return String(tpl || "").replace(/{{\s*([\w.]+)\s*}}/g, (_, k) => (ctx?.[k] ?? ""));
}

function toE164(raw) {
  const s = String(raw || "").replace(/\D/g, "");
  if (!s) return "";
  if (s.startsWith("1") && s.length === 11) return `+${s}`;
  if (s.length === 10) return `+1${s}`;
  if (String(raw).startsWith("+")) return String(raw);
  return `+${s}`;
}

async function getTemplatesAndFlags(userId) {
  const { data } = await supabase
    .from("message_templates")
    .select("templates, enabled")
    .eq("user_id", userId)
    .maybeSingle();
  return {
    templates: (data?.templates ?? {}) || {},
    enabled: (data?.enabled ?? {}) || {},
  };
}

async function getAgentContext(userId) {
  const { data } = await supabase
    .from("agent_profiles")
    .select("full_name, phone, calendly_url, company")
    .eq("user_id", userId)
    .maybeSingle();

  return {
    agent_name: data?.full_name || "Your agent",
    agent_phone: data?.phone || "",
    agent_email: "",
    company: data?.company || "Agency",
    calendly_link: data?.calendly_url || "",
    today: new Date().toLocaleDateString(),
  };
}

async function ensureMessageContact(userId, { full_name, phone, tags = [], meta = {} }) {
  const normalized = toE164(phone);
  if (!normalized) return null;

  const { data: existing } = await supabase
    .from("message_contacts")
    .select("id, subscribed")
    .eq("user_id", userId)
    .eq("phone", normalized)
    .maybeSingle();

  if (existing) {
    await supabase
      .from("message_contacts")
      .update({
        full_name: full_name || undefined,
        tags: tags.length ? tags : undefined,
        meta: Object.keys(meta || {}).length ? meta : undefined,
      })
      .eq("id", existing.id);
    return { id: existing.id, phone: normalized, subscribed: existing.subscribed };
  }

  const { data: row, error } = await supabase
    .from("message_contacts")
    .insert([{ user_id: userId, full_name, phone: normalized, tags, meta }])
    .select("id, subscribed")
    .single();
  if (error) throw error;
  return { id: row.id, phone: normalized, subscribed: row.subscribed };
}

async function sendSmsTelnyx({ to, text }) {
  const apiKey = process.env.TELNYX_API_KEY;
  const fromNumber = process.env.TELNYX_FROM_NUMBER;
  const profileId = process.env.TELNYX_MESSAGING_PROFILE_ID;

  if (!apiKey) throw new Error("TELNYX_API_KEY not configured");
  if (!fromNumber && !profileId) throw new Error("TELNYX_FROM_NUMBER or TELNYX_MESSAGING_PROFILE_ID required");

  const body = { to, text, ...(profileId ? { messaging_profile_id: profileId } : { from: fromNumber }) };

  const res = await fetch("https://api.telnyx.com/v2/messages", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`Telnyx send failed (${res.status}): ${err}`);
  }
  return res.json();
}

async function logEvent({ userId, contactId, leadId, templateKey, to, body, meta = {} }) {
  await supabase.from("message_events").insert([{
    user_id: userId,
    contact_id: contactId || null,
    lead_id: leadId || null,
    template_key: templateKey,
    to_phone: to,
    body,
    meta,
  }]);
}

/* ---------------- High-level flows ---------------- */

async function sendNewLeadIfEnabled({ userId, lead, leadId = null }) {
  const contact = await ensureMessageContact(userId, {
    full_name: lead.name || lead.full_name || "",
    phone: lead.phone,
    tags: ["lead"],
  });
  if (!contact || !contact.subscribed) return { sent: false, reason: "not_subscribed_or_missing" };

  const [{ templates, enabled }, agent] = await Promise.all([
    getTemplatesAndFlags(userId),
    getAgentContext(userId),
  ]);

  const isMilitary = !!String(lead.military_branch || "").trim();
  const templateKey = isMilitary ? "new_lead_military" : "new_lead";
  if (!enabled?.[templateKey]) return { sent: false, reason: "template_disabled" };

  const first_name = String(lead.name || lead.full_name || "").trim().split(/\s+/)[0] || "";
  const ctx = {
    ...agent,
    first_name,
    full_name: lead.name || lead.full_name || "",
    state: lead.state || "",
    beneficiary: lead.beneficiary || "",
    military_branch: lead.military_branch || "",
  };

  const tpl = templates?.[templateKey] || DEFAULTS[templateKey];
  const text = renderTemplate(tpl, ctx).trim();
  const to = contact.phone;

  await sendSmsTelnyx({ to, text });
  await logEvent({ userId, contactId: contact.id, leadId, templateKey, to, body: text });
  return { sent: true };
}

async function sendSoldIfEnabled({ userId, lead, leadId = null, sendNow = true }) {
  if (!sendNow) return { sent: false, reason: "ui_opt_out" };

  const contact = await ensureMessageContact(userId, {
    full_name: lead.name || lead.full_name || "",
    phone: lead.phone,
    tags: ["sold"],
  });
  if (!contact || !contact.subscribed) return { sent: false, reason: "not_subscribed_or_missing" };

  const [{ templates, enabled }, agent] = await Promise.all([
    getTemplatesAndFlags(userId),
    getAgentContext(userId),
  ]);
  if (!enabled?.sold) return { sent: false, reason: "template_disabled" };

  const first_name = String(lead.name || lead.full_name || "").trim().split(/\s+/)[0] || "";
  const ctx = {
    ...agent,
    first_name,
    full_name: lead.name || lead.full_name || "",
    carrier: lead.carrier || "",
    policy_number: lead.policy_number || "",
    premium: lead.premium || "",
  };

  const tpl = templates?.sold || DEFAULTS.sold;
  const text = renderTemplate(tpl, ctx).trim();
  const to = contact.phone;

  await sendSmsTelnyx({ to, text });
  await logEvent({ userId, contactId: contact.id, leadId, templateKey: "sold", to, body: text });
  return { sent: true };
}

/* optional generic helper for one-off sends */
async function sendTemplateIfEnabled({ userId, contact, templateKey, extraCtx = {}, leadId = null }) {
  const ensured = await ensureMessageContact(userId, { full_name: contact.full_name || "", phone: contact.phone });
  if (!ensured || !ensured.subscribed) return { sent: false, reason: "not_subscribed_or_missing" };

  const [{ templates, enabled }, agent] = await Promise.all([
    getTemplatesAndFlags(userId),
    getAgentContext(userId),
  ]);
  if (!enabled?.[templateKey]) return { sent: false, reason: "template_disabled" };

  const first_name = (contact.full_name || "").trim().split(/\s+/)[0] || "";
  const ctx = { ...agent, first_name, full_name: contact.full_name || "", ...extraCtx };
  const tpl = templates?.[templateKey] || "";
  if (!tpl) return { sent: false, reason: "no_template" };

  const text = renderTemplate(tpl, ctx).trim();
  const to = ensured.phone;

  await sendSmsTelnyx({ to, text });
  await logEvent({ userId, contactId: ensured.id, leadId, templateKey, to, body: text, meta: { ctxKeys: Object.keys(extraCtx) } });
  return { sent: true };
}

module.exports = {
  renderTemplate,
  toE164,
  getTemplatesAndFlags,
  getAgentContext,
  ensureMessageContact,
  sendSmsTelnyx,
  logEvent,
  sendNewLeadIfEnabled,
  sendSoldIfEnabled,
  sendTemplateIfEnabled,
};
