// File: netlify/functions/automation-payment.js
import { DateTime } from 'luxon';
import { createClient } from '@supabase/supabase-js';

export const config = { schedule: '5 15 * * *' }; // ~10:05 AM America/Chicago

const TZ = 'America/Chicago';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const SITE_URL = process.env.SITE_URL || 'https://remiecrm.com';

const supa = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);
const todayCH = () => DateTime.now().setZone(TZ);

const normalizePhone = (p) => {
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
async function sendTemplate({ to, user_id, templateKey, provider_message_id, placeholders }) {
  const res = await fetch(`${SITE_URL}/.netlify/functions/messages-send`, {
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
  if (!res.ok) throw new Error(`messages-send failed: ${res.status}`);
  return res.json();
}

export const handler = async () => {
  const supabase = supa();
  const today = todayCH();
  const ymd = today.toFormat('yyyyLLdd');

  // Subs contacts for join
  const { data: contacts } = await supabase
    .from('message_contacts')
    .select('id,user_id,full_name,phone,tags,subscribed,meta')
    .eq('subscribed', true);

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

  // Leads with pipeline data
  let leads = [];
  if (userIds.length) {
    const { data: lrows } = await supabase
      .from('leads')
      .select('id,user_id,name,phone,state,beneficiary,beneficiary_name,pipeline');
    leads = lrows || [];
  }

  let sent = 0;

  for (const user_id of userIds) {
    const templates = await fetchTemplates(supabase, user_id);
    if (!templates.payment_reminder) continue;

    const agent = await fetchAgent(supabase, user_id);
    const baseVars = {
      agent_name: agent.full_name || '',
      agent_phone: agent.phone || '',
      calendly_link: agent.calendly_url || '',
    };

    const phoneMap = phoneMapByUser.get(user_id) || new Map();
    const userLeads = leads.filter((l) => l.user_id === user_id);

    for (const l of userLeads) {
      const pj = l.pipeline || {};
      const dueDay = pj.payment_due_day;          // 1..28 (number or numeric string)
      const dueDate = pj.payment_due_date;        // 'YYYY-MM-DD'

      const isDue =
        (typeof dueDay === 'number' && dueDay === today.day) ||
        (typeof dueDay === 'string' && Number(dueDay) === today.day) ||
        (typeof dueDate === 'string' && dueDate === today.toFormat('yyyy-LL-dd'));

      if (!isDue) continue;

      const contact = phoneMap.get(normalizePhone(l.phone));
      if (!contact?.phone) continue;

      const pmid = `payment_${ymd}_${l.id}`;
      try {
        await sendTemplate({
          to: contact.phone,
          user_id,
          templateKey: 'payment_reminder',
          provider_message_id: pmid,
          placeholders: {
            ...baseVars,
            first_name: firstName(contact.full_name, firstName(l.name || '')),
            state: l.state || contact?.meta?.state || '',
            beneficiary: l.beneficiary_name || l.beneficiary || contact?.meta?.beneficiary || '',
          },
        });
        sent++;
      } catch (e) {
        console.warn('payment send failed', user_id, contact.id, e.message);
      }
    }
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true, sent }) };
};
