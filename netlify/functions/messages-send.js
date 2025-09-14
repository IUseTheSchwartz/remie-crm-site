// File: netlify/functions/messages-send.js
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const TELNYX_MESSAGING_PROFILE_ID = process.env.TELNYX_MESSAGING_PROFILE_ID;
const TELNYX_FROM_NUMBER = process.env.TELNYX_FROM_NUMBER;

const json = (obj, statusCode = 200) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(obj),
});

const supa = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

const norm10 = (p) => String(p || '').replace(/\D/g, '').slice(-10);
const toE164US = (p) => {
  const d = String(p || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('+')) return d;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  if (d.length === 10) return `+1${d}`;
  return null;
};
const mask = (p = '') => {
  const d = String(p).replace(/\D/g, '');
  return d ? `***${d.slice(-4)}` : '***';
};

function renderTemplate(raw, vars) {
  return String(raw || '').replace(/\{\{(\w+)\}\}/g, (_, k) => (vars?.[k] ?? ''));
}

async function fetchTemplates(db, user_id) {
  const { data, error } = await db
    .from('message_templates')
    .select('templates')
    .eq('user_id', user_id)
    .maybeSingle();
  if (error) throw error;
  return data?.templates || {};
}

async function fetchAgent(db, user_id) {
  const { data, error } = await db
    .from('agent_profiles')
    .select('full_name, phone, calendly_url')
    .eq('user_id', user_id)
    .maybeSingle();
  if (error) throw error;
  return data || {};
}

async function lookupContactByPhone(db, user_id, toRaw) {
  const exact = await db
    .from('message_contacts')
    .select('id,user_id,full_name,phone,subscribed,tags,meta')
    .eq('user_id', user_id)
    .eq('phone', toRaw)
    .maybeSingle();
  if (exact?.data) return exact.data;

  const last10 = norm10(toRaw);
  const { data } = await db
    .from('message_contacts')
    .select('id,user_id,full_name,phone,subscribed,tags,meta')
    .eq('user_id', user_id);

  return (data || []).find((c) => norm10(c.phone) === last10) || null;
}

async function insertMessageFlexible(db, row, trace) {
  try {
    const { data } = await db.from('messages').insert([row]).select('id').maybeSingle();
    if (data?.id) return data.id;
  } catch (e) {
    trace.push({ step: 'insert.full.error', error: e.message });
  }

  const minimal = {
    user_id: row.user_id,
    contact_id: row.contact_id,
    body: row.body,
    provider_message_id: row.provider_message_id ?? null,
    template_key: row.template_key ?? null,
    status: row.status ?? 'queued',
  };
  const { data, error } = await db.from('messages').insert([minimal]).select('id').maybeSingle();
  if (error) {
    trace.push({ step: 'insert.minimal.error', error: error.message });
    throw error;
  }
  return data?.id;
}

async function sendViaTelnyx({ to, text, client_ref, trace }) {
  const payload = {
    from: TELNYX_FROM_NUMBER,
    to,
    text,
    messaging_profile_id: TELNYX_MESSAGING_PROFILE_ID,
    client_ref,
  };
  trace.push({ step: 'telnyx.request', to: mask(to), textPreview: text.slice(0, 120) });

  const res = await fetch('https://api.telnyx.com/v2/messages', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TELNYX_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const raw = await res.text();
  let parsed;
  try { parsed = JSON.parse(raw); } catch { parsed = { raw }; }

  trace.push({ step: 'telnyx.response', status: res.status, ok: res.ok });

  if (!res.ok) {
    throw new Error(`Telnyx ${res.status}: ${typeof parsed === 'object' ? JSON.stringify(parsed) : String(parsed)}`);
  }
  return parsed; // { data: { id, ... } }
}

export const handler = async (evt) => {
  const trace = [];
  try {
    // no ?debug needed — we always return trace in the response
    if (evt.httpMethod !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE || !TELNYX_API_KEY || !TELNYX_MESSAGING_PROFILE_ID || !TELNYX_FROM_NUMBER) {
      return json({ error: 'server_misconfigured' }, 500);
    }

    let body;
    try { body = JSON.parse(evt.body || '{}'); }
    catch { return json({ error: 'invalid_json' }, 400); }

    // Flexible inputs
    let { user_id, to: toRaw, templateKey, provider_message_id, contact_id, lead_id } = body;
    const placeholdersIn = body.placeholders || {};
    const db = supa();

    trace.push({ step: 'input', has_user_id: !!user_id, has_to: !!toRaw, templateKey, contact_id, lead_id });

    // Hydrate from contact_id (optional)
    let contact = null;
    if (contact_id) {
      const { data: c, error } = await db
        .from('message_contacts')
        .select('id,user_id,full_name,phone,subscribed,tags,meta')
        .eq('id', contact_id)
        .maybeSingle();
      if (error) return json({ error: 'contact_lookup_failed', detail: error.message, trace }, 500);
      if (c) { contact = c; user_id = user_id || c.user_id; toRaw = toRaw || c.phone; }
      trace.push({ step: 'contact.hydrated', found: !!c, toRawMasked: mask(toRaw) });
    }

    // Hydrate from lead_id (optional) and get defaults
    let lead = null;
    let leadDefaults = {};
    if (lead_id) {
      const { data: l, error } = await db
        .from('leads')
        .select('id,user_id,name,phone,state,beneficiary,beneficiary_name,sold')
        .eq('id', lead_id)
        .maybeSingle();
      if (error) return json({ error: 'lead_lookup_failed', detail: error.message, trace }, 500);
      if (!l) return json({ error: 'lead_not_found', lead_id, trace }, 404);

      lead = l;
      user_id = user_id || l.user_id;
      toRaw = toRaw || l.phone || l?.sold?.phone || null;
      leadDefaults = {
        first_name: (l.name || '').trim().split(/\s+/)[0] || '',
        state: l.state || '',
        beneficiary: l.beneficiary_name || l.beneficiary || '',
        carrier: l?.sold?.carrier || '',
        policy_number: l?.sold?.policyNumber || '',
        premium: l?.sold?.premium || '',
        monthly_payment: l?.sold?.monthlyPayment || '',
        policy_start_date: l?.sold?.startDate || '',
        face_amount: l?.sold?.faceAmount || '',
      };
      trace.push({ step: 'lead.hydrated', user_id, toRawMasked: mask(toRaw) });
    }

    // Minimal requirements (supporting contact/lead hydration)
    if (!templateKey || (!user_id && !lead_id && !contact_id) || (!toRaw && !lead_id && !contact_id)) {
      return json({
        error: 'missing_fields',
        need: ['templateKey', 'and one of: (user_id + to) or (contact_id) or (lead_id)'],
        got: { user_id: !!user_id, templateKey: !!templateKey, to: !!toRaw, contact_id: !!contact_id, lead_id: !!lead_id },
        trace
      }, 400);
    }

    // If still no contact and we have user_id + to, try to find by phone
    if (!contact && toRaw && user_id) contact = await lookupContactByPhone(db, user_id, toRaw);

    // For new leads, auto-create minimal contact if still missing (rare)
    if (!contact && (templateKey === 'new_lead' || templateKey === 'new_military') && toRaw && user_id) {
      const { data: created, error } = await db
        .from('message_contacts')
        .insert([{
          user_id,
          full_name: leadDefaults.first_name || '',
          phone: toRaw,
          subscribed: true,
          tags: [templateKey === 'new_military' ? 'military' : 'lead'],
          meta: { state: leadDefaults.state, beneficiary: leadDefaults.beneficiary }
        }])
        .select('id,user_id,full_name,phone,subscribed,tags,meta')
        .maybeSingle();
      if (error) return json({ error: 'contact_create_failed', detail: error.message, trace }, 500);
      contact = created;
      trace.push({ step: 'contact.autocreated', contact_id: contact.id });
    }

    if (!contact) return json({ error: 'contact_not_found_for_phone', trace }, 404);
    if (!contact.subscribed) return json({ error: 'contact_unsubscribed', trace }, 400);

    // Eligibility from tags (+ automation prefix if provided)
    const tags = contact?.tags || [];
    const hasLeadOrMil = tags.includes('lead') || tags.includes('military');
    const hasSold = tags.includes('sold');
    const isAutomation = typeof provider_message_id === 'string' && provider_message_id.length > 0;
    const automationOK = /^((sold|appt|holiday|birthday|payment|followup_2d|new_lead|new_military)_?)/i.test(provider_message_id || '');
    const eligible = hasLeadOrMil || (isAutomation && (automationOK || hasSold)) || hasSold || templateKey === 'new_lead' || templateKey === 'new_military';

    trace.push({ step: 'eligibility', tags, hasLeadOrMil, hasSold, isAutomation, automationOK, templateKey, eligible });
    if (!eligible) return json({ error: 'contact_not_eligible', trace }, 400);

    // Dedupe by provider_message_id
    if (provider_message_id) {
      const { data: dupe } = await db
        .from('messages')
        .select('id')
        .eq('user_id', user_id)
        .eq('contact_id', contact.id)
        .eq('provider_message_id', provider_message_id)
        .limit(1);
      if (dupe && dupe.length) return json({ ok: true, deduped: true, provider_message_id, trace }, 200);
    }

    // Template + agent
    const templates = await fetchTemplates(db, user_id);
    let template = templates?.[templateKey];
    if (!template && templateKey === 'new_military') template = templates?.['new_lead']; // optional fallback
    if (!template) return json({ error: 'template_not_found', templateKey, trace }, 404);

    const agent = await fetchAgent(db, user_id);
    const vars = {
      // precedence: incoming placeholders -> lead defaults -> contact meta -> agent
      first_name: placeholdersIn.first_name || leadDefaults.first_name || (contact.full_name || '').split(/\s+/)[0] || '',
      state: placeholdersIn.state || leadDefaults.state || contact?.meta?.state || '',
      beneficiary: placeholdersIn.beneficiary || leadDefaults.beneficiary || contact?.meta?.beneficiary || '',
      carrier: placeholdersIn.carrier || leadDefaults.carrier || '',
      policy_number: placeholdersIn.policy_number || leadDefaults.policy_number || '',
      premium: placeholdersIn.premium || leadDefaults.premium || '',
      monthly_payment: placeholdersIn.monthly_payment || leadDefaults.monthly_payment || '',
      policy_start_date: placeholdersIn.policy_start_date || leadDefaults.policy_start_date || '',
      face_amount: placeholdersIn.face_amount || leadDefaults.face_amount || '',
      agent_name: placeholdersIn.agent_name || agent?.full_name || '',
      agent_phone: placeholdersIn.agent_phone || agent?.phone || '',
      calendly_link: placeholdersIn.calendly_link || agent?.calendly_url || '',
    };

    const text = renderTemplate(template, vars);
    const to = toE164US(toRaw || contact.phone);
    if (!to) return json({ error: 'invalid_phone', trace }, 400);

    // Send via Telnyx
    let providerResp;
    try {
      providerResp = await sendViaTelnyx({ to, text, client_ref: provider_message_id || undefined, trace });
    } catch (e) {
      trace.push({ step: 'telnyx.error', error: e.message });
      try {
        await insertMessageFlexible(db, {
          user_id,
          contact_id: contact.id,
          direction: 'out',
          to_number: to,
          from_number: TELNYX_FROM_NUMBER,
          body: text,
          template_key: templateKey,
          provider: 'telnyx',
          provider_message_id: provider_message_id || null,
          status: 'failed',
        }, trace);
      } catch (_) {}
      return json({ error: 'provider_send_failed', detail: e.message, trace }, 502);
    }

    // Record message (queued; webhook will update status later)
    const provider_id = providerResp?.data?.id || null;
    const message_id = await insertMessageFlexible(db, {
      user_id,
      contact_id: contact.id,
      direction: 'out',
      to_number: to,
      from_number: TELNYX_FROM_NUMBER,
      body: text,
      template_key: templateKey,
      provider: 'telnyx',
      provider_message_id: provider_message_id || provider_id || null,
      status: 'queued',
    }, trace);

    // Wallet debit (1¢) — non-blocking; uses your public.user_wallets via RPC helper
    try {
      await db.rpc('user_wallets_debit', { p_user_id: user_id, p_amount: 1 });
      trace.push({ step: 'wallet.debit.ok' });
    } catch (e) {
      trace.push({ step: 'wallet.debit.error', error: e.message });
    }

    return json({
      ok: true,
      message_id,
      provider_message_id: provider_message_id || provider_id || null,
      provider: 'telnyx',
      trace, // always included so you can see errors in the console/Network view
    });
  } catch (e) {
    return json({ error: 'unhandled_server_error', detail: String(e?.message || e), trace }, 500);
  }
};
