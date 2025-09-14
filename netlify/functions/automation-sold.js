// File: netlify/functions/automation-sold.js
import { createClient } from '@supabase/supabase-js';

export const config = { schedule: '*/10 * * * *' }; // every 10 minutes

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const SITE_URL = process.env.SITE_URL || 'https://remiecrm.com';

const supa = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

const normPhone = (p) => {
  const d = String(p || '').replace(/\D/g, '');
  return d.length > 10 ? d.slice(-10) : d;
};
const firstName = (full = '', fb = '') => {
  const n = String(full || '').trim();
  return n ? n.split(/\s+/)[0] : (fb || '');
};

async function fetchTemplates(supabase, user_id) {
  const { data } = await supabase
    .from('message_templates')
    .select('templates')
    .eq('user_id', user_id)
    .maybeSingle();
  return data?.templates || {};
}
async function fetchAgent(supabase, user_id) {
  const { data } = await supabase
    .from('agent_profiles')
    .select('full_name, phone, calendly_url')
    .eq('user_id', user_id)
    .maybeSingle();
  return data || {};
}
async function sendTemplate({ to, user_id, provider_message_id, placeholders }) {
  const res = await fetch(`${SITE_URL}/.netlify/functions/messages-send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user_id,
      to,
      templateKey: 'sold',
      placeholders,
      client_ref: provider_message_id,
      provider_message_id,
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`messages-send failed: ${res.status} ${txt}`);
  }
  return res.json();
}

export const handler = async () => {
  const supabase = supa();

  // 1) Contacts that are subscribed AND have the 'sold' tag
  const { data: contacts, error: cErr } = await supabase
    .from('message_contacts')
    .select('id,user_id,full_name,phone,tags,subscribed,meta')
    .eq('subscribed', true)
    .contains('tags', ['sold']);
  if (cErr) {
    console.error('contacts error', cErr);
    return { statusCode: 500, body: JSON.stringify({ ok: false }) };
  }
  if (!contacts?.length) {
    return { statusCode: 200, body: JSON.stringify({ ok: true, sent: 0, reason: 'no_contacts_with_sold_tag' }) };
  }

  // Build phone map
  const byUser = new Map();
  const phoneMapByUser = new Map();
  const userIds = new Set();
  for (const c of contacts) {
    if (!c.phone) continue;
    userIds.add(c.user_id);
    if (!byUser.has(c.user_id)) {
      byUser.set(c.user_id, []);
      phoneMapByUser.set(c.user_id, new Map());
    }
    byUser.get(c.user_id).push(c);
    phoneMapByUser.get(c.user_id).set(normPhone(c.phone), c);
  }

  // 2) Leads with sold JSON for those users
  let leads = [];
  if (userIds.size) {
    const { data: lrows, error: lErr } = await supabase
      .from('leads')
      .select('id,user_id,name,phone,state,beneficiary,beneficiary_name,status,sold,updated_at')
      .in('user_id', Array.from(userIds))
      .not('sold', 'is', null);
    if (lErr) {
      console.error('leads error', lErr);
    } else {
      leads = lrows || [];
    }
  }

  // Index leads by (user_id, last10 phone) using both leads.phone and sold.phone; prefer most recent updated_at
  const bestLeadByUserPhone = new Map();
  for (const l of leads) {
    const candidates = [l.phone, l?.sold?.phone].filter(Boolean).map(normPhone);
    for (const p of candidates) {
      const key = `${l.user_id}:${p}`;
      const prev = bestLeadByUserPhone.get(key);
      if (!prev || new Date(l.updated_at) >= new Date(prev.updated_at || 0)) {
        bestLeadByUserPhone.set(key, l);
      }
    }
  }

  let sent = 0;

  for (const user_id of userIds) {
    const templates = await fetchTemplates(supabase, user_id);
    if (!templates.sold) continue;

    const agent = await fetchAgent(supabase, user_id);
    const baseVars = {
      agent_name: agent?.full_name || '',
      agent_phone: agent?.phone || '',
      calendly_link: agent?.calendly_url || '',
    };

    const contactsList = byUser.get(user_id) || [];
    for (const c of contactsList) {
      const lead = bestLeadByUserPhone.get(`${user_id}:${normPhone(c.phone)}`);
      if (!lead) continue;

      const s = lead.sold || {};
      if (!s.policyNumber && !s.carrier && !s.monthlyPayment && !s.startDate) {
        // nothing meaningful to send
        continue;
      }

      const pmid = `sold_${lead.id}`;

      // dedupe
      const { data: existing } = await supabase
        .from('messages')
        .select('id')
        .eq('user_id', user_id)
        .eq('contact_id', c.id)
        .eq('provider_message_id', pmid)
        .limit(1);
      if (existing && existing.length) continue;

      try {
        await sendTemplate({
          to: c.phone,
          user_id,
          provider_message_id: pmid,
          placeholders: {
            ...baseVars,
            first_name: firstName(c.full_name, firstName(lead.name || '')),
            state: lead.state || c?.meta?.state || '',
            beneficiary: lead.beneficiary_name || lead.beneficiary || c?.meta?.beneficiary || '',
            carrier: s.carrier || '',
            policy_number: s.policyNumber || '',
            premium: s.premium || '',
            monthly_payment: s.monthlyPayment || '',
            policy_start_date: s.startDate || '',
            face_amount: s.faceAmount || '',
          },
        });
        sent++;
      } catch (e) {
        console.warn('sold send failed', { user_id, contact_id: c.id, lead_id: lead.id, error: e.message });
      }
    }
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true, sent }) };
};
