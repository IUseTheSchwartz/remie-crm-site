// File: netlify/functions/messages-send.js
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

// Telnyx envs (set in Netlify UI)
const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const TELNYX_MESSAGING_PROFILE_ID = process.env.TELNYX_MESSAGING_PROFILE_ID;
const TELNYX_FROM_NUMBER = process.env.TELNYX_FROM_NUMBER; // +15551234567

const LOG_PREFIX = '[messages-send]';
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
const maskPhone = (p) => {
  const d = String(p || '').replace(/\D/g, '');
  if (d.length < 4) return '***';
  return `***${d.slice(-4)}`;
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

async function fetchTemplates(supabase, user_id, trace) {
  const { data, error } = await supabase
    .from('message_templates')
    .select('templates')
    .eq('user_id', user_id)
    .maybeSingle();
  if (error) {
    trace.push({ step: 'fetchTemplates.error', error: error.message });
    throw error;
  }
  trace.push({ step: 'fetchTemplates.ok', hasTemplates: !!data?.templates, keys: data?.templates ? Object.keys(data.templates) : [] });
  return data?.templates || {};
}

async function fetchAgent(supabase, user_id, trace) {
  const { data, error } = await supabase
    .from('agent_profiles')
    .select('full_name, phone, calendly_url')
    .eq('user_id', user_id)
    .maybeSingle();
  if (error) {
    trace.push({ step: 'fetchAgent.error', error: error.message });
    throw error;
  }
  trace.push({ step: 'fetchAgent.ok', hasAgent: !!data, agentPreview: data ? { full_name: data.full_name || '', phone: maskPhone(data.phone || '') } : null });
  return data || {};
}

async function findContactByPhone(supabase, user_id, to, trace) {
  // exact
  const exact = await supabase
    .from('message_contacts')
    .select('id,user_id,full_name,phone,subscribed,tags,meta')
    .eq('user_id', user_id)
    .eq('phone', to)
    .maybeSingle();

  if (exact?.data) {
    trace.push({ step: 'findContact.exact', found: true, contact_id: exact.data.id, subscribed: exact.data.subscribed, tags: exact.data.tags || [], phone: maskPhone(exact.data.phone) });
    return exact.data;
  }

  // last-10 match
  const last10 = norm10(to);
  const { data: candidates, error } = await supabase
    .from('message_contacts')
    .select('id,user_id,full_name,phone,subscribed,tags,meta')
    .eq('user_id', user_id);
  if (error) {
    trace.push({ step: 'findContact.candidates.error', error: error.message });
    throw error;
  }
  const match = (candidates || []).find((c) => norm10(c.phone) === last10) || null;
  trace.push({ step: 'findContact.last10', found: !!match, triedLast10: last10, contact_id: match?.id || null, subscribed: match?.subscribed ?? null, tags: match?.tags || [], phone: match ? maskPhone(match.phone) : null });
  return match;
}

async function createMinimalContactForNewLead(supabase, user_id, toRaw, placeholders, trace) {
  const full_name = (placeholders?.first_name || '').trim();
  const payload = {
    user_id,
    full_name,
    phone: toRaw,
    subscribed: true,
    tags: ['lead'],
    meta: {},
  };
  trace.push({ step: 'createMinimalContact.payload', payload: { ...payload, phone: maskPhone(payload.phone) } });
  const { data, error } = await supabase
    .from('message_contacts')
    .insert([payload])
    .select('id,user_id,full_name,phone,subscribed,tags,meta')
    .maybeSingle();

  if (error) {
    trace.push({ step: 'createMinimalContact.error', error: error.message });
    throw error;
  }
  trace.push({ step: 'createMinimalContact.ok', contact_id: data.id, phone: maskPhone(data.phone) });
  return data;
}

async function insertMessageFlexible(supabase, row, trace) {
  // First try: full row
  try {
    const { data } = await supabase.from('messages').insert([row]).select('id').maybeSingle();
    if (data?.id) {
      trace.push({ step: 'insertMessage.full.ok', message_id: data.id });
      return data.id;
    }
  } catch (e) {
    trace.push({ step: 'insertMessage.full.error', error: e.message });
  }
  // Fallback: minimal, in case schema differs
  const minimal = {
    user_id: row.user_id,
    contact_id: row.contact_id,
    body: row.body,
    provider_message_id: row.provider_message_id ?? null,
    template_key: row.template_key ?? null,
    status: row.status ?? 'queued',
  };
  try {
    const { data } = await supabase.from('messages').insert([minimal]).select('id').maybeSingle();
    if (data?.id) {
      trace.push({ step: 'insertMessage.minimal.ok', message_id: data.id });
      return data.id;
    }
  } catch (e2) {
    trace.push({ step: 'insertMessage.minimal.error', error: e2.message, minimal });
    throw e2;
  }
}

async function sendViaTelnyx({ to, text, client_ref, trace }) {
  const payload = {
    from: TELNYX_FROM_NUMBER,
    to,
    text,
    messaging_profile_id: TELNYX_MESSAGING_PROFILE_ID,
    client_ref,
  };
  trace.push({ step: 'telnyx.request', to: maskPhone(to), textPreview: text.slice(0, 80), client_ref: client_ref || null });
  const res = await fetch('https://api.telnyx.com/v2/messages', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TELNYX_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const payloadText = await res.text();
  let parsed;
  try { parsed = JSON.parse(payloadText); } catch { parsed = { raw: payloadText }; }
  trace.push({ step: 'telnyx.response', status: res.status, ok: res.ok, hasData: !!parsed?.data });

  if (!res.ok) {
    throw new Error(`Telnyx ${res.status}: ${typeof parsed === 'object' ? JSON.stringify(parsed) : String(parsed)}`);
  }
  return parsed; // { data: { id, ... } }
}

export const handler = async (evt) => {
  const trace = [];
  try {
    const qs = new URLSearchParams(evt.rawQuery || '');
    const debug = qs.get('debug') === '1' || process.env.DEBUG_MESSAGES_SEND === '1';

    console.log(LOG_PREFIX, 'start', { debug });
    if (evt.httpMethod !== 'POST') {
      trace.push({ step: 'httpMethod', method: evt.httpMethod });
      console.warn(LOG_PREFIX, 'method_not_allowed', evt.httpMethod);
      return json({ error: 'method_not_allowed', trace: debug ? trace : undefined }, 405);
    }

    // Env checks
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
      trace.push({ step: 'env.supabase.missing' });
      console.error(LOG_PREFIX, 'server_misconfigured_supabase');
      return json({ error: 'server_misconfigured_supabase', trace: debug ? trace : undefined }, 500);
    }
    if (!TELNYX_API_KEY || !TELNYX_MESSAGING_PROFILE_ID || !TELNYX_FROM_NUMBER) {
      trace.push({ step: 'env.telnyx.missing' });
      console.error(LOG_PREFIX, 'server_misconfigured_telnyx');
      return json({ error: 'server_misconfigured_telnyx', trace: debug ? trace : undefined }, 500);
    }

    // Parse body
    let body;
    try {
      body = JSON.parse(evt.body || '{}');
    } catch {
      trace.push({ step: 'parse.error' });
      return json({ error: 'invalid_json', trace: debug ? trace : undefined }, 400);
    }
    const user_id = body.user_id;
    const templateKey = body.templateKey;
    const toRaw = body.to;
    const placeholders = body.placeholders || {};
    const pmid = body.provider_message_id || body.client_ref || ''; // automation identifier
    const debugBody = body.debug === true;

    trace.push({ step: 'input', user_id, templateKey, toRawMasked: maskPhone(toRaw), hasPlaceholders: !!placeholders, pmid, debugBody });

    if (!user_id || !templateKey || !toRaw) {
      trace.push({ step: 'input.missing' });
      return json({ error: 'missing_fields', trace: debug ? trace : undefined }, 400);
    }

    const supabase = supa();

    // 1) Contact lookup; auto-create for new_lead if missing
    let contact = await findContactByPhone(supabase, user_id, toRaw, trace);
    if (!contact && templateKey === 'new_lead') {
      try {
        contact = await createMinimalContactForNewLead(supabase, user_id, toRaw, placeholders, trace);
      } catch (e) {
        trace.push({ step: 'new_lead.autoCreate.error', error: e.message });
      }
    }
    if (!contact) {
      trace.push({ step: 'contact.not_found' });
      console.warn(LOG_PREFIX, 'contact_not_found_for_phone', { user_id, to: maskPhone(toRaw) });
      return json({ error: 'contact_not_found_for_phone', trace: debug || debugBody ? trace : undefined }, 404);
    }
    if (!contact.subscribed) {
      trace.push({ step: 'contact.unsubscribed', contact_id: contact.id });
      return json({ error: 'contact_unsubscribed', trace: debug || debugBody ? trace : undefined }, 400);
    }

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

    trace.push({
      step: 'eligibility',
      contact_id: contact.id,
      tags,
      hasLeadOrMilitary,
      hasSold,
      isAutomation,
      automationOK,
      templateKey,
      eligible,
    });

    if (!eligible) {
      console.warn(LOG_PREFIX, 'contact_not_eligible', { contact_id: contact.id, tags, pmid, templateKey });
      return json({ error: 'contact_not_eligible', trace: debug || debugBody ? trace : undefined }, 400);
    }

    // 3) Dedupe
    if (pmid) {
      const { data: dupe, error: dupeErr } = await supabase
        .from('messages')
        .select('id')
        .eq('user_id', user_id)
        .eq('contact_id', contact.id)
        .eq('provider_message_id', pmid)
        .limit(1);
      trace.push({ step: 'dedupe.check', dupeErr: dupeErr?.message || null, dupeCount: dupe?.length || 0 });
      if (dupe && dupe.length) {
        console.log(LOG_PREFIX, 'deduped', { contact_id: contact.id, pmid });
        return json({ ok: true, deduped: true, provider_message_id: pmid, trace: debug || debugBody ? trace : undefined }, 200);
      }
    }

    // 4) Template + agent
    const templates = await fetchTemplates(supabase, user_id, trace);
    const template = templates?.[templateKey];
    if (!template) {
      trace.push({ step: 'template.missing', templateKey });
      return json({ error: 'template_not_found', templateKey, trace: debug || debugBody ? trace : undefined }, 404);
    }
    const agent = await fetchAgent(supabase, user_id, trace);
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
    if (!to) {
      trace.push({ step: 'phone.invalid', toRaw });
      return json({ error: 'invalid_phone', trace: debug || debugBody ? trace : undefined }, 400);
    }

    // 5) Telnyx send
    let providerResp;
    try {
      providerResp = await sendViaTelnyx({ to, text, client_ref: pmid || undefined, trace });
    } catch (e) {
      trace.push({ step: 'telnyx.send.error', error: e.message });
      console.warn(LOG_PREFIX, 'telnyx_error', e.message);
      // Attempt to write a failed message row (flexible)
      try {
        await insertMessageFlexible(supabase, {
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
        }, trace);
      } catch (e2) {
        trace.push({ step: 'insert.failed.afterTelnyxError', error: e2.message });
      }
      return json({ error: 'provider_send_failed', detail: e.message, trace: debug || debugBody ? trace : undefined }, 502);
    }

    // 6) Record message (queued; webhook will update later)
    const provider_id = providerResp?.data?.id || null;
    let message_id;
    try {
      message_id = await insertMessageFlexible(supabase, {
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
      }, trace);
    } catch (e) {
      trace.push({ step: 'insertMessage.final.error', error: e.message });
      // We still return ok because the provider accepted the message; but we reveal the trace in debug
    }

    // 7) Wallet debit (1¢) — non-blocking
    try {
      const { error: rpcErr } = await supabase.rpc('user_wallets_debit', {
        p_user_id: user_id,
        p_amount: 1,
      });
      if (rpcErr) trace.push({ step: 'wallet.debit.error', error: rpcErr.message });
      else trace.push({ step: 'wallet.debit.ok' });
    } catch (e) {
      trace.push({ step: 'wallet.debit.exception', error: e.message });
    }

    const out = {
      ok: true,
      message_id: message_id || null,
      provider_message_id: pmid || provider_id || null,
      provider: 'telnyx',
    };
    if (debug || debugBody) out.trace = trace;
    console.log(LOG_PREFIX, 'success', { message_id: out.message_id, provider_message_id: out.provider_message_id });
    return json(out, 200);
  } catch (e) {
    console.error(LOG_PREFIX, 'unhandled', e);
    return json({ error: 'unhandled_server_error', detail: String(e?.message || e) }, 500);
  }
};
