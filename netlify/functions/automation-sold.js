// File: netlify/functions/automation-sold.js
import { createClient } from '@supabase/supabase-js';

export const config = { schedule: '*/10 * * * *' }; // every 10 minutes

// Toggle: require leads.status='sold' ?
// If false, will send when leads.sold JSON exists regardless of status.
const REQUIRE_STATUS_SOLD = true;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const SITE_URL = process.env.SITE_URL || 'https://remiecrm.com';

const supa = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);
const normalizePhone = (p) => {
  const d = String(p || '').replace(/\D/g, '');
  return d.length > 10 ? d.slice(-10) : d;
};
const firstName = (full = '', fb = '') => {
  const n = String(full || '').trim();
  return n ? n.split(/\s+/)[0] : (fb || '');
};

async function fetchTemplates(supabase, user_id) {
  const { data, error } = await supabase
    .from('message_templates')
    .select('templates')
    .eq('user_id', user_id)
    .maybeSingle();
  if (error) {
    console.error('templates fetch error', user_id, error);
    return {};
  }
  return data?.templates || {};
}
async function fetchAgent(supabase, user_id) {
  const { data, error } = await supabase
    .from('agent_profiles')
    .select('full_name, phone, calendly_url')
    .eq('user_id', user_id)
    .maybeSingle();
  if (error) console.error('agent fetch error', user_id, error);
  return data || {};
}
async function sendTemplate({ to, user_id, templateKey, provider_message_id, placeholders }) {
  const url = `${SITE_URL}/.netlify/functions/messages-send`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user_id,
      to,
      templateKey,
      placeholders,
      client_ref: provider_message_id,
      provider_message_id,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`messages-send failed (${res.status}): ${text}`);
  }
  return res.json();
}

export const handler = async () => {
  const supabase = supa();

  // Contacts (subscribed only)
  const { data: contacts, error: cErr } = await supabase
    .from('message_contacts')
    .select('id,user_id,full_name,phone,subscribed,meta')
    .eq('subscribed', true);
  if (cErr) {
    console.error('contacts error', cErr);
    return { statusCode: 500, body: JSON.stringify({ ok: false }) };
  }

  const byUser = new Map();
  const phoneMapByUser = new Map();
  for (const c of contacts || []) {
    if (!c.phone) continue;
    if (!byUser.has(c.user_id)) {
      byUser.set(c.user_id, []);
      phoneMapByUser.set(c.user_id, new Map());
    }
    byUser.get(c.user_id).push(c);
    phoneMapByUser.get(c.user_id).set(normalizePhone(c.phone), c);
  }
  const userIds = Array.from(byUser.keys());
  if (!userIds.length) {
    console.log('no subscribed contacts found');
    return { statusCode: 200, body: JSON.stringify({ ok: true, sent: 0 }) };
  }

  // Leads with sold JSON (and optional status filter)
  let q = supabase
    .from('leads')
    .select('id,user_id,name,phone,state,beneficiary,beneficiary_name,status,sold,updated_at')
    .in('user_id', userIds)
    .not('sold', 'is', null);

  if (REQUIRE_STATUS_SOLD) q = q.eq('status', 'sold');

  const { data: leads, error: lErr } = await q;
  if (lErr) {
    console.error('leads error', lErr);
    return { statusCode: 500, body: JSON.stringify({ ok: false }) };
  }

  let sent = 0;
  for (const user_id of userIds) {
    const templates = await fetchTemplates(supabase, user_id);
    if (!templates.sold) {
      console.log('no sold template, skipping user', user_id);
      continue;
    }

    const agent = await fetchAgent(supabase, user_id);
    const baseVars = {
      agent_name: agent.full_name || '',
      agent_phone: agent.phone || '',
      calendly_link: agent.calendly_url || '',
    };

    const phoneMap = phoneMapByUser.get(user_id) || new Map();
    const userLeads = (leads || []).filter((l) => l.user_id === user_id);

    for (const l of userLeads) {
      const s = l.sold || {};
      const contact = phoneMap.get(normalizePhone(l.phone));
      if (!contact?.phone) {
        console.log('skip: no matching contact', { lead_id: l.id, phone: l.phone });
        continue;
      }

      const pmid = `sold_${l.id}`;
      const { data: existing, error: mErr } = await supabase
        .from('messages')
        .select('id')
        .eq('user_id', user_id)
        .eq('contact_id', contact.id)
        .eq('provider_message_id', pmid)
        .limit(1);

      if (mErr) {
        console.warn('message check error', mErr);
        continue;
      }
      if (existing && existing.length) {
        console.log('skip: dedupe exists', { lead_id: l.id, pmid });
        continue;
      }

      try {
        await sendTemplate({
          to: contact.phone,
          user_id,
          templateKey: 'sold',
          provider_message_id: pmid,
          placeholders: {
            ...baseVars,
            first_name: (contact.full_name || l.name || '').split(/\s+/)[0] || '',
            state: l.state || contact?.meta?.state || '',
            beneficiary: l.beneficiary_name || l.beneficiary || contact?.meta?.beneficiary || '',
            carrier: s.carrier || '',
            policy_number: s.policyNumber || '',
            premium: s.premium || '',
            monthly_payment: s.monthlyPayment || '',
            policy_start_date: s.startDate || '',
            face_amount: s.faceAmount || '',
          },
        });
        sent++;
        console.log('sent sold message', { user_id, lead_id: l.id, contact_id: contact.id, pmid });
      } catch (e) {
        console.warn('send failed', { user_id, lead_id: l.id, contact_id: contact.id, error: e.message });
      }
    }
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true, sent }) };
};
