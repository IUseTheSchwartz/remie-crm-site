// File: netlify/functions/messages-send.js
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

// Telnyx envs (set in Netlify UI)
const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const TELNYX_MESSAGING_PROFILE_ID = process.env.TELNYX_MESSAGING_PROFILE_ID;
const TELNYX_FROM_NUMBER = process.env.TELNYX_FROM_NUMBER; // +15551234567

const json = (obj, statusCode = 200) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(obj),
});

const supa = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

const norm10 = (p) => {
  const d = String(p || '').replace(/\D/g, '');
  return d.length > 10 ? d.slice(-10) : d;
};

const toE164US = (p) => {
  const d = String(p || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('+')) return d;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  if (d.length === 10) return `+1${d}`;
  return null;
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
  // Try exact match first
  const exact = await supabase
    .from('message_contacts')
    .select('id,user_id,full_name,phone,subscribed,tags,meta')
    .eq('user_id', user_id)
    .eq('phone', to)
    .maybeSingle();
  if (exact?.data) return exact.data;

  // Fallback to last-10-digit match
  const last10 = norm10(to);
  const { data: candidates, error } = await supabase
    .from('message_contacts')
    .select('id,user_id,full_name,phone,subscribed,tags,meta')
    .eq('user_id', user_id);
  if (error) throw error;

  return (candidates || []).find((c) => norm10(c.phone) === last10) || null;
}

async function createMinimalContactForNewLead(supabase, user_id, toRaw, placeholders) {
  const full_name = (placeholders?.first_name || '').trim();
  const { data, error } = await supabase
    .from('message_contacts')
    .insert([{
      user_id,
      full_name,
      phone: toRaw,
      subscribed: true,
      tags: ['lead'],
      meta: {}
    }])
    .select('id,user_id,full_name,phone,subscribed,tags,meta')
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function insertMessage(supabase, row) {
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
      client_ref, // becomes provider_message_id in your DB/webhook flow
    }),
  });

  const payloadText = await res.text();
  let payload;
  try { payload = JSON.parse(payloadText); } catch { payload = { raw: payloadText }; }

  if (!res.ok) {
    const info = typeof payload === 'object' ? JSON.stringify(payload) : String(payload);
    throw new Error(`Telnyx ${res.status}: ${info}`);
  }
  return payload; // { data: { id, ... } }
}

export const handler = async (evt) => {
  try {
    if (evt.httpMethod !== 'POST') {
      return json({ error: 'method_not_allowed' }, 405);
    }

    // Ensure required envs
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
      return json({ error: 'server_misconfigured_supabase' }, 500);
    }
    if (!TELNYX_API_KEY || !TELNYX_MESSAGING_PROFILE_ID || !TELNYX_FROM_NUMBER) {
      return json({ error: 'server_misconfigured_telnyx' }, 500);
    }

    let body;
    try {
      body = JSON.parse(evt.body || '{}');
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }

    const user_id = body.user_id;
    const templateKey = body.templateKey;
    const toRaw = body.to;
    const placeholders = body.placeholders || {};
    const pmid = body.provider_message_id || body.client_ref || ''; // automation identifier

    if (!user_id || !templateKey || !toRaw) {
      return json({ error: 'missing_fields' }, 400);
    }

    const supabase = supa();

    // 1) Find contact by phone; if it's a NEW LEAD, auto-create if missing
    let contact = await findContactByPhone(supabase, user_id, toRaw);
    if (!contact && templateKey === 'new_lead') {
      try {
        contact = await createMinimalContactForNewLead(supabase, user_id, toRaw, placeholders);
      } catch (e) {
        console.warn('auto-create contact failed for new_lead', e.message);
      }
    }
    if (!contact) return json({ error: 'contact_not_found_for_phone' }, 404);
    if (!contact.subscribed) return json({ error: 'contact_unsubscribed' }, 400);

    // 2) Eligibility gate
    const tags = contact?.tags || [];
    const hasLeadOrMilitary = tags.includes('lead') || tags.includes('military');
    const hasSold = tags.includes('sold');
    const isAutomation = typeof pmid === 'string' && pmid.length > 0;
    const automationOK = /^((sold|appt|holiday|birthday|payment|followup_2d|new_lead)_?)/i.test(pmid);

    const eligible =
      hasLeadOrMilitary ||
      (isAutomation && (automationOK || hasSold)) ||
      hasSold ||
      templateKey === 'new_lead';

    if (!eligible) {
      return json({ error: 'contact_not_eligible' }, 400);
    }

    // 3) Dedupe by provider_message_id (if provided)
    if (pmid) {
      const { data: dupe, error: dupeErr } = await supabase
        .from('messages')
        .select('id')
        .eq('user_id', user_id)
        .eq('contact_id', contact.id)
        .eq('provider_message_id', pmid)
        .limit(1);
      if (dupeErr) console.warn('dedupe check error', dupeErr);
      if (dupe && dupe.length) {
        return json({ ok: true, deduped: true, provider_message_id: pmid }, 200);
      }
    }

    // 4) Fetch template + agent vars
    const templates = await fetchTemplates(supabase, user_id);
    const template = templates?.[templateKey];
    if (!template) return json({ error: 'template_not_found', templateKey }, 404);

    const agent = await fetchAgent(supabase, user_id);
    const vars = {
      agent_name: agent?.full_name || placeholders.agent_name || '',
      agent_phone: agent?.phone || placeholders.agent_phone || '',
      calendly_link: agent?.calendly_url || placeholders.calendly_link || '',
      first_name: placeholders.first_name || (contact.full_name || '').split(/\s+/)[0] || '',
      state: placeholders.state || contact?.meta?.state || '',
      beneficiary: placeholders.beneficiary || contact?.meta?.beneficiary || '',
      // extras for sold/payment
      monthly_payment: placeholders.monthly_payment || '',
      carrier: placeholders.carrier || '',
      policy_number: placeholders.policy_number || '',
      premium: placeholders.premium || '',
      policy_start_date: placeholders.policy_start_date || '',
      face_amount: placeholders.face_amount || '',
    };

    const text = renderTemplate(template, vars);
    const to = toE164US(toRaw);
    if (!to) return json({ error: 'invalid_phone' }, 400);

    // 5) Send via Telnyx
    let providerResp;
    try {
      providerResp = await sendViaTelnyx({
        to,
        text,
        client_ref: pmid || undefined,
      });
    } catch (e) {
      console.warn('telnyx send error', e.message);
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
      return json({ error: 'provider_send_failed', detail: e.message }, 502);
    }

    // 6) Record message (queued; telnyx-status webhook updates later)
    const provider_id = providerResp?.data?.id || null;
    const message_id = await insertMessage(supabase, {
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

    // 7) Debit wallet 1¢ using your existing table (non-blocking)
    try {
      await supabase.rpc('user_wallets_debit', {
        p_user_id: user_id,
        p_amount: 1, // cents
      });
    } catch (e) {
      console.warn('user_wallets_debit failed (non-blocking)', e.message);
    }

    return json({
      ok: true,
      message_id,
      provider_message_id: pmid || provider_id || null,
      provider: 'telnyx',
    });
  } catch (e) {
    console.error('messages-send unhandled error', e);
    return json({ error: 'unhandled_server_error', detail: String(e?.message || e) }, 500);
  }
};
