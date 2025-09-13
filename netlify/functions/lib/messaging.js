// File: netlify/functions/lib/messaging.js
// CommonJS helpers for messaging flows (new lead, sold, birthday/holiday, one-offs)

const fetch = global.fetch || ((...a) => import("node-fetch").then(({ default: f }) => f(...a)));
const { getServiceClient } = require("../_supabase.js");
const supabase = getServiceClient();

/* ---------- Basic helpers ---------- */
function toE164(raw) {
  const s = String(raw || "").replace(/\D/g, "");
  if (!s) return "";
  if (s.startsWith("1") && s.length === 11) return `+${s}`;
  if (s.length === 10) return `+1${s}`;
  if (String(raw).startsWith("+")) return String(raw);
  return `+${s}`;
}

function renderTemplate(str, ctx) {
  return String(str || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, k) => (ctx?.[k] ?? ""));
}

/* ---------- Defaults (shortened for brevity — keep yours if already set) ---------- */
const DEFAULTS = {
  new_lead:
    "Hi {{first_name}}, this is {{agent_name}}. I received your life insurance request. Quick 5–10 min call to confirm info? You can also pick a time: {{calendly_link}}",
  new_lead_military:
    "Hi {{first_name}}, this is {{agent_name}}. I see a military background—thank you for your service. I’ll tailor options accordingly. Book here: {{calendly_link}}",
  sold:
    "Hi {{first_name}}, it’s {{agent_name}}. Your policy details are on file. If anything looks off or you have questions, text me anytime at {{agent_phone}}.",
  nudge_48h:
    "Hey {{first_name}}, haven’t heard back. Let’s book your life insurance consult from the form you submitted (beneficiary: {{beneficiary}}). Here’s my link: {{calendly_link}}",
};

const DEFAULT_ENABLED = {
  new_lead: true,
  new_lead_military: true,
  sold: true,
  nudge_48h: true,
};

/* ---------- Reads ---------- */
async function getTemplatesAndFlags(userId) {
  const { data } = await supabase
    .from("message_templates")
    .select("templates, enabled")
    .eq("user_id", userId)
    .maybeSingle();

  const templates = (data?.templates ?? {}) || {};
  const enabled = (data?.enabled ?? templates.__enabled ?? {}) || {};
  return { templates: { ...DEFAULTS, ...templates }, enabled: { ...DEFAULT_ENABLED, ...enabled } };
}

async function getAgentContext(userId) {
  const { data } = await supabase
    .from("agent_profiles")
    .select("full_name, phone, calendly_url, company, email")
    .eq("user_id", userId)
    .maybeSingle();

  return {
    agent_name: data?.full_name || "Your agent",
    agent_phone: data?.phone || "",
    agent_email: data?.email || "",
    company: data?.company || "Agency",
    calendly_link: data?.calendly_url || "",
    today: new Date().toLocaleDateString(),
  };
}

/* ---------- Contacts ---------- */
async function ensureMessageContact(userId, { full_name, phone, tags = [], meta = {} }) {
  const normalized = toE164(phone);
  if (!normalized) return null;

  const { data: existing } = await supabase
    .from("message_contacts")
    .select("id, subscribed, tags, meta")
    .eq("user_id", userId)
    .eq("phone", normalized)
    .maybeSingle();

  const nextTags = Array.from(new Set([...(existing?.tags || []), ...tags])).filter(Boolean);
  const nextMeta = { ...(existing?.meta || {}), ...meta };

  if (existing) {
    await supabase
      .from("message_contacts")
      .update({ full_name: full_name || existing.full_name || "", tags: nextTags, meta: nextMeta })
      .eq("id", existing.id);
    return { id: existing.id, phone: normalized, subscribed: existing.subscribed };
  }

  const { data: row, error } = await supabase
    .from("message_contacts")
    .insert([{ user_id: userId, full_name: full_name || "", phone: normalized, tags: nextTags, meta: nextMeta }])
    .select("id, subscribed")
    .single();
  if (error) throw error;
  return { id: row.id, phone: normalized, subscribed: row.subscribed };
}

/* ---------- Wallet + recording ---------- */
async function debitWalletOrThrow(userId, cents = 1) {
  // Atomic-ish: only update if enough balance
  const { data, error } = await supabase
    .from("user_wallets")
    .update({ balance_cents: supabase.rpc ? undefined : undefined }) // no-op to please linter
    .eq("user_id", userId)
    .gte("balance_cents", cents)
    .select("balance_cents")
    .limit(1);

  // Supabase JS doesn’t do atomic math client-side; use RPC if you have it; fallback to guarded update:
  // Prefer this RPC in SQL section below: rpc: wallet_debit(user_id uuid, amount int)
  if (error || !data || !data.length) {
    // Try RPC if present
    try {
      const { data: ok, error: rpcErr } = await supabase.rpc("wallet_debit", { p_user_id: userId, p_amount: cents });
      if (rpcErr || ok !== true) throw rpcErr || new Error("Insufficient balance");
      return;
    } catch (e) {
      throw new Error("Insufficient balance");
    }
  }
}

async function recordOutgoingMessage({ userId, contactId, leadId, to, from, body, providerSid, costCents = 1 }) {
  await supabase.from("messages").insert([{
    user_id: userId,
    contact_id: contactId || null,
    lead_id: leadId || null,
    provider: "telnyx",
    provider_sid: providerSid || null,
    direction: "outgoing",
    from_number: from || null,
    to_number: to,
    body,
    status: "queued",
    cost_cents: costCents,
  }]);
  // touch contact meta last_outgoing_at
  await supabase.from("message_contacts").update({
    meta: { last_outgoing_at: new Date().toISOString() },
  }).eq("id", contactId);
}

/* ---------- Telnyx send ---------- */
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

  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = j?.errors?.[0]?.detail || "Telnyx send failed";
    const err = new Error(detail);
    err.telnyx = j;
    throw err;
  }
  return { telnyxId: j?.data?.id || null, fromUsed: fromNumber || null };
}

/* ---------- Event log ---------- */
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

/* ---------- Flow: New Lead ---------- */
async function sendNewLeadIfEnabled({ userId, lead, leadId = null }) {
  const contact = await ensureMessageContact(userId, {
    full_name: lead.name || lead.full_name || "",
    phone: lead.phone,
    tags: ["lead", ...(lead.military_branch ? ["military"] : [])],
    meta: { beneficiary: lead.beneficiary || "" },
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
    beneficiary: lead.beneficiary || "",
    military_branch: lead.military_branch || "",
  };

  const tpl = templates?.[templateKey] || DEFAULTS[templateKey];
  const text = renderTemplate(tpl, ctx).trim();
  const to = contact.phone;

  // Wallet debit then send + record
  await debitWalletOrThrow(userId, 1);
  const { telnyxId, fromUsed } = await sendSmsTelnyx({ to, text });
  await recordOutgoingMessage({ userId, contactId: contact.id, leadId, to, from: fromUsed, body: text, providerSid: telnyxId, costCents: 1 });
  await logEvent({ userId, contactId: contact.id, leadId, templateKey, to, body: text });
  return { sent: true };
}

/* ---------- Flow: Sold ---------- */
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
  const ctx = { ...agent, first_name, full_name: lead.name || lead.full_name || "", carrier: lead.carrier || "", policy_number: lead.policy_number || "", premium: lead.premium || "" };

  const tpl = templates?.sold || DEFAULTS.sold;
  const text = renderTemplate(tpl, ctx).trim();
  const to = contact.phone;

  await debitWalletOrThrow(userId, 1);
  const { telnyxId, fromUsed } = await sendSmsTelnyx({ to, text });
  await recordOutgoingMessage({ userId, contactId: contact.id, leadId, to, from: fromUsed, body: text, providerSid: telnyxId, costCents: 1 });
  await logEvent({ userId, contactId: contact.id, leadId, templateKey: "sold", to, body: text });
  return { sent: true };
}

/* ---------- Generic template sender ---------- */
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
  const tpl = templates?.[templateKey] || DEFAULTS[templateKey] || "";
  if (!tpl) return { sent: false, reason: "no_template" };

  const text = renderTemplate(tpl, ctx).trim();
  const to = ensured.phone;

  await debitWalletOrThrow(userId, 1);
  const { telnyxId, fromUsed } = await sendSmsTelnyx({ to, text });
  await recordOutgoingMessage({ userId, contactId: ensured.id, leadId, to, from: fromUsed, body: text, providerSid: telnyxId, costCents: 1 });
  await logEvent({ userId, contactId: ensured.id, leadId, templateKey, to, body: text });
  return { sent: true };
}

module.exports = {
  // utils
  renderTemplate,
  toE164,
  // reads
  getTemplatesAndFlags,
  getAgentContext,
  // contacts
  ensureMessageContact,
  // sending + logs
  sendSmsTelnyx,
  logEvent,
  // flows
  sendNewLeadIfEnabled,
  sendSoldIfEnabled,
  sendTemplateIfEnabled,
};
