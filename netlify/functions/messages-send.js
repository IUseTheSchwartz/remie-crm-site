// File: netlify/functions/messages-send.js
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

// Telnyx envs (set these in Netlify UI)
const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const TELNYX_MESSAGING_PROFILE_ID = process.env.TELNYX_MESSAGING_PROFILE_ID;
const TELNYX_FROM_NUMBER = process.env.TELNYX_FROM_NUMBER; // e.g. +15551234567

const supa = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

const norm10 = (p) => {
  const d = String(p || '').replace(/\D/g, '');
  return d.length > 10 ? d.slice(-10) : d;
};

const toE164US = (p) => {
  const d = String(p || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  if (d.length === 10) return `+1${d}`;
  if (d.startsWith('+')) return d;
  return `+${d}`;
};

function renderTemplate(raw, vars) {
  const str = String(raw || '');
  return str.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars?.[k] ?? ''));
}

async function fetchTemplates(supabase, user_id) {
  const { data, error } = await supabase
    .from('message_templates')
    .select('templates')
    .eq('user_id', user_id)
    .maybeSingle();
  if (error) throw error;
  return data?.templates || {};
}

async function fetchAgent(supabase, user_id) {
  const { data, error } = await supabase
    .from('agent_profiles')
    .select('full_name, phone, calendly_url')
    .eq('user_id', user_id)
    .maybeSingle();
  if (error) throw error;
  return data || {};
}

async function findContactByPhone(supabase, user_id, to) {
  // Try exact, then last-10 match
  const exact = await supabase
    .from('message_contacts')
    .select('id,user_id,full_name,phone,subscribed,tags,meta')
    .eq('user_id', user_id)
    .eq('phone', to)
    .maybeSingle();

  if (exact.data) return exact.data;

  const last10 = norm10(to);
  const { data: candidates } = await supabase
    .from('message_contacts')
    .select('id,user_id,full_name,phone,subscribed,tags,meta')
    .eq('user_id', user_id);

  return (candidates || []).find((c) => norm10(c.phone) === last10) || null;
}

async function insertMessage(supabase, row) {
  // Minimal insert; adjust columns to match your schema if needed
  const { data, error } = await supabase
    .from('messages')
    .insert([row])
    .select('id')
    .maybeSingle();
  if (error) throw error;
  return data?.id;
}

async function sendViaTelnyx({ to, text, client_ref }) {
  const res = await fetch('https://api.telnyx.com/v2/messages', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TELNYX_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: TELNYX_FROM_NUMBER,
      to,
      text,
      messaging_profile_id: TELNYX_MESSAGING_PROFILE_ID,
      client_ref, // shows up as provider_message_id in your DB/webhook flow
    }),
  });

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const info = typeof payload === 'object' ? JSON.stringify(payload) : String(payload);
    throw new Error(`Telnyx error ${res.status}: ${info}`);
  }
  return payload; // { data: { id, ... } }
}

export const handler = async (evt) => {
  if (evt.httpMethod !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const supabase = supa();
  let body;
  try {
    body = JSON.parse(evt.body || '{}');
  } catch {
    return new Response(JSON.stringify({ error: 'invalid_json' }), { status: 400 });
  }

  const user_id = body.user_id;
  const templateKey = body.templateKey;
  const toRaw = body.to;
  const placeholders = body.placeholders || {};
  const pmid = body.provider_message_id || body.client_ref || ''; // automation identifier (if present)

  if (!user_id || !templateKey || !toRaw) {
    return new Response(JSON.stringify({ error: 'missing_fields' }), { status: 400 });
  }

  // 1) resolve contact
  const contact = await findContactByPhone(supabase, user_id, toRaw);
  if (!contact) {
    return new Response(JSON.stringify({ error: 'contact_not_found_for_phone' }), { status: 404 });
  }
  if (!contact.subscribed) {
    return new Response(JSON.stringify({ error: 'contact_unsubscribed' }), { status: 400 });
  }

  // 2) eligibility gate (THIS WAS THE BLOCKER)
  const tags = contact?.tags || [];
  const hasLeadOrMilitary = tags.includes('lead') || tags.includes('military');
  const hasSold = tags.includes('sold');
  const isAutomation = typeof pmid === 'string' && pmid.length > 0;
  const automationOK = /^((sold|appt|holiday|birthday|payment|followup_2d)_)/i.test(pmid);

  // Rule:
  // - Manual sends still require lead/military
  // - Automations are allowed if pmid prefix matches OR the contact has 'sold'
  const eligible =
    hasLeadOrMilitary ||
    (isAutomation && (automationOK || hasSold)) ||
    hasSold;

  if (!eligible) {
    return new Response(JSON.stringify({ error: 'contact_not_eligible' }), { status: 400 });
  }

  // 3) dedupe on provider_message_id if present
  if (pmid) {
    const { data: dupe } = await supabase
      .from('messages')
      .select('id')
      .eq('user_id', user_id)
      .eq('contact_id', contact.id)
      .eq('provider_message_id', pmid)
      .limit(1);

    if (dupe && dupe.length) {
      return new Response(JSON.stringify({ ok: true, deduped: true, provider_message_id: pmid }), {
        status: 200,
      });
    }
  }

  // 4) fetch template and (optionally) agent info for fallback placeholders
  const templates = await fetchTemplates(supabase, user_id);
  const template = templates?.[templateKey];
  if (!template) {
    return new Response(JSON.stringify({ error: 'template_not_found', templateKey }), { status: 404 });
  }

  const agent = await fetchAgent(supabase, user_id);
  const vars = {
    agent_name: agent?.full_name || placeholders.agent_name || '',
    agent_phone: agent?.phone || placeholders.agent_phone || '',
    calendly_link: agent?.calendly_url || placeholders.calendly_link || '',
    first_name: placeholders.first_name || (contact.full_name || '').split(/\s+/)[0] || '',
    state: placeholders.state || contact?.meta?.state || '',
    beneficiary: placeholders.beneficiary || contact?.meta?.beneficiary || '',
    monthly_payment: placeholders.monthly_payment || '',
    carrier: placeholders.carrier || '',
    policy_number: placeholders.policy_number || '',
    premium: placeholders.premium || '',
    policy_start_date: placeholders.policy_start_date || '',
    face_amount: placeholders.face_amount || '',
  };

  const text = renderTemplate(template, vars);
  const to = toE164US(toRaw);
  if (!to) {
    return new Response(JSON.stringify({ error: 'invalid_phone' }), { status: 400 });
  }

  // 5) send via Telnyx
  let providerResp;
  try {
    providerResp = await sendViaTelnyx({
      to,
      text,
      client_ref: pmid || undefined,
    });
  } catch (e) {
    // still record a failed message row for traceability
    try {
      await insertMessage(supabase, {
        user_id,
        contact_id: contact.id,
        direction: 'out',
        to_number: to,
        from_number: TELNYX_FROM_NUMBER,
        body: text,
        template_key: templateKey,
        provider: 'telnyx',
        provider_message_id: pmid || null,
        status: 'failed',
      });
    } catch (_) {}
    return new Response(JSON.stringify({ error: 'provider_send_failed', detail: e.message }), {
      status: 502,
    });
  }

  // 6) record message (status will be updated by your telnyx-status webhook)
  const provider_id = providerResp?.data?.id || null;
  const msgId = await insertMessage(supabase, {
    user_id,
    contact_id: contact.id,
    direction: 'out',
    to_number: to,
    from_number: TELNYX_FROM_NUMBER,
    body: text,
    template_key: templateKey,
    provider: 'telnyx',
    provider_message_id: pmid || provider_id || null,
    status: 'queued',
  });

  return new Response(
    JSON.stringify({
      ok: true,
      message_id: msgId,
      provider_message_id: pmid || provider_id || null,
      provider: 'telnyx',
    }),
    { status: 200 }
  );
};
