// File: netlify/functions/messages-send.js
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const TELNYX_MESSAGING_PROFILE_ID = process.env.TELNYX_MESSAGING_PROFILE_ID;
const TELNYX_FROM_NUMBER = process.env.TELNYX_FROM_NUMBER;

const json = (obj, statusCode = 200) => ({
  statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj),
});
const supa = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

const norm10 = (p) => String(p || '').replace(/\D/g, '').slice(-10);
const toE164US = (p) => {
  const d = String(p || '').replace(/\D/g, ''); if (!d) return null;
  if (d.startsWith('+')) return d; if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  if (d.length === 10) return `+1${d}`; return null;
};
const mask = (p='') => (String(p).replace(/\D/g,'').slice(-4) ? '***' + String(p).replace(/\D/g,'').slice(-4) : '***');

function renderTemplate(raw, vars) {
  return String(raw || '').replace(/\{\{(\w+)\}\}/g, (_, k) => (vars?.[k] ?? ''));
}

async function fetchTemplates(db, user_id) {
  const { data, error } = await db.from('message_templates').select('templates').eq('user_id', user_id).maybeSingle();
  if (error) throw error; return data?.templates || {};
}
async function fetchAgent(db, user_id) {
  const { data, error } = await db.from('agent_profiles').select('full_name, phone, calendly_url').eq('user_id', user_id).maybeSingle();
  if (error) throw error; return data || {};
}

async function lookupContact(db, user_id, toRaw) {
  const exact = await db.from('message_contacts')
    .select('id,user_id,full_name,phone,subscribed,tags,meta')
    .eq('user_id', user_id).eq('phone', toRaw).maybeSingle();
  if (exact?.data) return exact.data;
  const last10 = norm10(toRaw);
  const { data } = await db.from('message_contacts')
    .select('id,user_id,full_name,phone,subscribed,tags,meta').eq('user_id', user_id);
  return (data || []).find(c => norm10(c.phone) === last10) || null;
}
async function createContactForNewLead(db, user_id, toRaw, name, state, beneficiary) {
  const { data, error } = await db.from('message_contacts').insert([{
    user_id, full_name: (name || '').trim(), phone: toRaw, subscribed: true, tags: ['lead'],
    meta: { state: state || '', beneficiary: beneficiary || '' }
  }]).select('id,user_id,full_name,phone,subscribed,tags,meta').maybeSingle();
  if (error) throw error; return data;
}
async function insertMessageFlexible(db, row, trace) {
  try {
    const { data } = await db.from('messages').insert([row]).select('id').maybeSingle();
    if (data?.id) return data.id;
  } catch (e) { trace.push({ step: 'insert.full.error', error: e.message }); }
  const minimal = {
    user_id: row.user_id, contact_id: row.contact_id, body: row.body,
    provider_message_id: row.provider_message_id ?? null, template_key: row.template_key ?? null,
    status: row.status ?? 'queued',
  };
  const { data, error } = await db.from('messages').insert([minimal]).select('id').maybeSingle();
  if (error) { trace.push({ step: 'insert.minimal.error', error: error.message }); throw error; }
  return data?.id;
}
async function sendViaTelnyx({ to, text, client_ref, trace }) {
  const payload = { from: TELNYX_FROM_NUMBER, to, text, messaging_profile_id: TELNYX_MESSAGING_PROFILE_ID, client_ref };
  trace.push({ step: 'telnyx.request', to: mask(to), textPreview: text.slice(0, 120) });
  const res = await fetch('https://api.telnyx.com/v2/messages', {
    method: 'POST', headers: { Authorization: `Bearer ${TELNYX_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.text(); let parsed; try { parsed = JSON.parse(body); } catch { parsed = { raw: body }; }
  trace.push({ step: 'telnyx.response', status: res.status, ok: res.ok });
  if (!res.ok) throw new Error(`Telnyx ${res.status}: ${typeof parsed === 'object' ? JSON.stringify(parsed) : String(parsed)}`);
  return parsed;
}

export const handler = async (evt) => {
  const trace = [];
  try {
    const debug = new URLSearchParams(evt.rawQuery || '').get('debug') === '1';
    if (evt.httpMethod !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE || !TELNYX_API_KEY || !TELNYX_MESSAGING_PROFILE_ID || !TELNYX_FROM_NUMBER) {
      return json({ error: 'server_misconfigured' }, 500);
    }
    let body; try { body = JSON.parse(evt.body || '{}'); } catch { return json({ error: 'invalid_json' }, 400); }

    const db = supa();

    // Inputs (new flexible modes)
    let { user_id, user_email, to: toRaw, templateKey, provider_message_id, contact_id, lead_id } = body;
    const placeholdersIn = body.placeholders || {};

    trace.push({ step: 'input', has_user_id: !!user_id, has_user_email: !!user_email, has_to: !!toRaw, templateKey, contact_id, lead_id });

    // If contact_id provided, hydrate user_id + to from DB
    let contact = null;
    if (contact_id) {
      const { data: c, error } = await db.from('message_contacts')
        .select('id,user_id,full_name,phone,subscribed,tags,meta')
        .eq('id', contact_id).maybeSingle();
      if (error) return json({ error: 'contact_lookup_failed', detail: error.message, trace: debug ? trace : undefined }, 500);
      if (c) { contact = c; user_id = user_id || c.user_id; toRaw = toRaw || c.phone; }
      trace.push({ step: 'contact.hydrated', found: !!c, toRawMasked: mask(toRaw) });
    }

    // If lead_id provided, hydrate user_id + to from DB (and collect default placeholders)
    let lead = null; let leadDefaults = {};
    if (lead_id) {
      const { data: l, error } = await db.from('leads')
        .select('id,user_id,name,phone,state,beneficiary,beneficiary_name,sold')
        .eq('id', lead_id).maybeSingle();
      if (error) return json({ error: 'lead_lookup_failed', detail: error.message, trace: debug ? trace : undefined }, 500);
      if (l) {
        lead = l; user_id = user_id || l.user_id; toRaw = toRaw || l.phone || l?.sold?.phone || null;
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
      }
      trace.push({ step: 'lead.hydrated', found: !!l, toRawMasked: mask(toRaw) });
    }

    // Resolve user by email if still missing
    if (!user_id && user_email) {
      const { data: u } = await db.from('profiles').select('id,email').eq('email', user_email).maybeSingle();
      if (u?.id) user_id = u.id;
      trace.push({ step: 'user.resolve.email', success: !!u?.id });
    }

    // Helpful missing-fields message (now aware of contact_id/lead_id path)
    if (!user_id || !templateKey || (!toRaw && !contact_id && !lead_id)) {
      return json({
        error: 'missing_fields',
        need: ['templateKey', 'and one of: (user_id + to) or (contact_id) or (lead_id)'],
        got: { user_id: !!user_id, templateKey: !!templateKey, to: !!toRaw, contact_id: !!contact_id, lead_id: !!lead_id }
      }, 400);
    }

    // If we don’t have a contact yet, try to find by phone now (using user_id)
    if (!contact && toRaw && user_id) contact = await lookupContact(db, user_id, toRaw);

    // Auto-create a contact for new_lead if still missing (race-safe)
    if (!contact && templateKey === 'new_lead' && toRaw && user_id) {
      try {
        contact = await createContactForNewLead(db, user_id, toRaw,
          lead?.name || placeholdersIn.first_name || '', lead?.state || '', leadDefaults.beneficiary || '');
        trace.push({ step: 'contact.autocreate.new_lead', created: true, contact_id: contact.id });
      } catch (e) {
        trace.push({ step: 'contact.autocreate.error', error: e.message });
      }
    }

    if (!contact) {
      // If we still cannot find a contact, create a minimal one (only when we have user_id + toRaw)
      if (user_id && toRaw) {
        const { data: created, error } = await db.from('message_contacts').insert([{
          user_id, phone: toRaw, subscribed: true, tags: templateKey === 'new_lead' ? ['lead'] : ['lead'], meta: {}
        }]).select('id,user_id,full_name,phone,subscribed,tags,meta').maybeSingle();
        if (error) return json({ error: 'contact_create_failed', detail: error.message, trace: debug ? trace : undefined }, 500);
        contact = created;
        trace.push({ step: 'contact.autocreate.generic', contact_id: contact.id });
      } else {
        return json({ error: 'contact_not_found_for_phone', trace: debug ? trace : undefined }, 404);
      }
    }
    if (!contact.subscribed) return json({ error: 'contact_unsubscribed', trace: debug ? trace : undefined }, 400);

    // Eligibility
    const tags = contact?.tags || [];
    const hasLeadOrMil = tags.includes('lead') || tags.includes('military');
    const hasSold = tags.includes('sold');
    const isAutomation = typeof provider_message_id === 'string' && provider_message_id.length > 0;
    const automationOK = /^((sold|appt|holiday|birthday|payment|followup_2d|new_lead)_?)/i.test(provider_message_id || '');
    const eligible = hasLeadOrMil || (isAutomation && (automationOK || hasSold)) || hasSold || templateKey === 'new_lead';
    trace.push({ step: 'eligibility', tags, hasLeadOrMil, hasSold, isAutomation, automationOK, templateKey, eligible });
    if (!eligible) return json({ error: 'contact_not_eligible', trace: debug ? trace : undefined }, 400);

    // Dedupe
    if (provider_message_id) {
      const { data: dupe } = await db.from('messages').select('id')
        .eq('user_id', user_id).eq('contact_id', contact.id).eq('provider_message_id', provider_message_id).limit(1);
      if (dupe && dupe.length) return json({ ok: true, deduped: true, provider_message_id, trace: debug ? trace : undefined }, 200);
    }

    // Template & agent
    const templates = await fetchTemplates(db, user_id);
    const template = templates?.[templateKey];
    if (!template) return json({ error: 'template_not_found', templateKey, trace: debug ? trace : undefined }, 404);
    const agent = await fetchAgent(db, user_id);

    // Build vars (lead defaults -> contact meta -> incoming placeholders -> agent fallbacks)
    const vars = {
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
    if (!to) return json({ error: 'invalid_phone', trace: debug ? trace : undefined }, 400);

    // Send
    let providerResp;
    try {
      providerResp = await sendViaTelnyx({ to, text, client_ref: provider_message_id || undefined, trace });
    } catch (e) {
      trace.push({ step: 'telnyx.error', error: e.message });
      try {
        await insertMessageFlexible(db, {
          user_id, contact_id: contact.id, direction: 'out', to_number: to, from_number: TELNYX_FROM_NUMBER,
          body: text, template_key: templateKey, provider: 'telnyx',
          provider_message_id: provider_message_id || null, status: 'failed',
        }, trace);
      } catch (_) {}
      return json({ error: 'provider_send_failed', detail: e.message, trace: debug ? trace : undefined }, 502);
    }

    // Record message
    const provider_id = providerResp?.data?.id || null;
    const message_id = await insertMessageFlexible(db, {
      user_id, contact_id: contact.id, direction: 'out', to_number: to, from_number: TELNYX_FROM_NUMBER,
      body: text, template_key: templateKey, provider: 'telnyx',
      provider_message_id: provider_message_id || provider_id || null, status: 'queued',
    }, trace);

    // Wallet debit (1¢) — non-blocking
    try { await db.rpc('user_wallets_debit', { p_user_id: user_id, p_amount: 1 }); }
    catch (e) { trace.push({ step: 'wallet.debit.error', error: e.message }); }

    const out = { ok: true, message_id, provider_message_id: provider_message_id || provider_id || null, provider: 'telnyx' };
    if (debug) out.trace = trace; return json(out, 200);
  } catch (e) {
    return json({ error: 'unhandled_server_error', detail: String(e?.message || e), trace }, 500);
  }
};
