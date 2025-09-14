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

async function sendTemplate({ to, user_id, provider_message_id, placeholders }) {
  const url = `${SITE_URL}/.netlify/functions/messages-send`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user_id,
      to,
      templateKey: 'sold',
      placeholders,
      client_ref: provider_message_id,   // maps to provider_message_id in your sender
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

  // Build indices
  const byUser = new Map();                  // user_id -> contacts[]
  const phoneMapByUser = new Map();          // user_id -> Map(last10 -> contact)
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

  // 2) Fetch leads for these users that have SOLD json (policy details)
  let leads = [];
  if (userIds.size) {
    const { data: lrows, error: lErr } = await supabase
      .from('leads')
      .select('id,user_id,name,phone,state,beneficiary,beneficiary_name,status,sold,updated_at')
      .in('user_id', Array.from(userIds))
      .not('sold', 'is', null); // must have sold JSON
    if (lErr) {
      console.error('leads error', lErr);
      leads = [];
    } else {
      leads = lrows || [];
    }
  }

  // Index leads by (user_id, phone) using both leads.phone and sold.phone; keep the most recent updated_at
  const bestLeadByUserPhone = new Map(); // key `${user_id}:${last10}` -> lead
  for (const l of leads) {
    const candidates = [l.phone, l?.sold?.phone].filter(Boolean).map(normPhone);
    for (const p of candidates) {
      const key = `${l.user_id}:${p}`;
      const prev = bestLeadByUserPhone.get(key);
      if (!prev) {
        bestLeadByUserPhone.set(key, l);
      } else {
        const prevTS = new Date(prev.updated_at || 0).getTime();
        const curTS = new Date(l.updated_at || 0).getTime();
        if (curTS >= prevTS) bestLeadByUserPhone.set(key, l);
      }
    }
  }

  let sent = 0;
  const results = [];

  // 3) Per user processing
  for (const user_id of userIds) {
    const templates = await fetchTemplates(supabase, user_id);
    if (!templates.sold) {
      // No sold template for this user; skip all their contacts
      continue;
    }
    const agent = await fetchAgent(supabase, user_id);
    const baseVars = {
      agent_name: agent.full_name || '',
      agent_phone: agent.phone || '',
      calendly_link: agent.calendly_url || '',
    };

    const contactsList = byUser.get(user_id) || [];
    for (const c of contactsList) {
      const key = `${user_id}:${normPhone(c.phone)}`;
      const lead = bestLeadByUserPhone.get(key);

      if (!lead) {
        results.push({ contact_id: c.id, reason: 'no_matching_lead_with_sold_json' });
        continue;
      }

      const s = lead.sold || {};
      // Ensure we actually have useful policy info
      if (!s.policyNumber && !s.carrier && !s.monthlyPayment && !s.startDate) {
        results.push({ contact_id: c.id, lead_id: lead.id, reason: 'sold_json_missing_policy_fields' });
        continue;
      }

      const pmid = `sold_${lead.id}`;

      // Dedupe check on provider_message_id
      const { data: existing, error: mErr } = await supabase
        .from('messages')
        .select('id')
        .eq('user_id', user_id)
        .eq('contact_id', c.id)
        .eq('provider_message_id', pmid)
        .limit(1);
      if (mErr) {
        console.warn('message check error', mErr);
        continue;
      }
      if (existing && existing.length) {
        results.push({ contact_id: c.id, lead_id: lead.id, status: 'skipped', reason: 'dedupe_exists' });
        continue;
      }

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
        results.push({ contact_id: c.id, lead_id: lead.id, status: 'sent', pmid });
      } catch (e) {
        console.warn('send failed', { user_id, contact_id: c.id, lead_id: lead.id, error: e.message });
        results.push({ contact_id: c.id, lead_id: lead.id, status: 'error', error: e.message });
      }
    }
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true, sent, results }) };
};
