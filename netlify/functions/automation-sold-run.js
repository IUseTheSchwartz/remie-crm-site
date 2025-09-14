// File: netlify/functions/automation-sold-run.js
import { createClient } from '@supabase/supabase-js';

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
  const text = await res.text();
  if (!res.ok) throw new Error(`messages-send failed (${res.status}): ${text}`);
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

export const handler = async (evt) => {
  const supabase = supa();
  const qp = new URLSearchParams(evt.rawQuery || '');
  const userEmail = qp.get('user_email') || null;
  const leadId = qp.get('lead_id') || null;
  const force = (qp.get('force') || '').toLowerCase() === 'true';

  // Contacts with 'sold' tag (eligible pool)
  const { data: contacts } = await supabase
    .from('message_contacts')
    .select('id,user_id,full_name,phone,subscribed,tags,meta')
    .eq('subscribed', true)
    .contains('tags', ['sold']);

  const byUser = new Map();
  const phoneMapByUser = new Map();
  for (const c of contacts || []) {
    if (!c.phone) continue;
    if (!byUser.has(c.user_id)) {
      byUser.set(c.user_id, []);
      phoneMapByUser.set(c.user_id, new Map());
    }
    byUser.get(c.user_id).push(c);
    phoneMapByUser.get(c.user_id).set(normPhone(c.phone), c);
  }

  // Resolve user filter via profiles (email -> id)
  let filterUserIds = Array.from(byUser.keys());
  if (userEmail) {
    const { data: u } = await supabase
      .from('profiles')
      .select('id,email')
      .eq('email', userEmail)
      .maybeSingle();
    if (!u?.id) {
      return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'user_not_found' }) };
    }
    filterUserIds = [u.id];
  }
  if (!filterUserIds.length) {
    return { statusCode: 200, body: JSON.stringify({ ok: true, sent: 0, reason: 'no_contacts_with_sold_tag' }) };
  }

  // Leads with sold JSON for these users
  let q = supabase
    .from('leads')
    .select('id,user_id,name,phone,state,beneficiary,beneficiary_name,sold,updated_at')
    .in('user_id', filterUserIds)
    .not('sold', 'is', null);

  if (leadId) q = q.eq('id', leadId);

  const { data: leads, error: lErr } = await q;
  if (lErr) return { statusCode: 500, body: JSON.stringify({ ok: false, error: lErr.message }) };

  // Build best lead per phone map
  const bestLeadByUserPhone = new Map();
  for (const l of leads || []) {
    const candidates = [l.phone, l?.sold?.phone].filter(Boolean).map(normPhone);
    for (const p of candidates) {
      const key = `${l.user_id}:${p}`;
      const prev = bestLeadByUserPhone.get(key);
      if (!prev || new Date(l.updated_at) >= new Date(prev.updated_at || 0)) {
        bestLeadByUserPhone.set(key, l);
      }
    }
  }

  const results = { ok: true, attempts: [], sent: 0 };

  for (const user_id of filterUserIds) {
    const phoneMap = phoneMapByUser.get(user_id) || new Map();
    const userContacts = (byUser.get(user_id) || []);

    for (const c of userContacts) {
      // If leadId specified, filter to the single matching lead/contact
      let targetLead = bestLeadByUserPhone.get(`${user_id}:${normPhone(c.phone)}`);
      if (leadId && targetLead?.id !== leadId) continue;
      if (!targetLead) {
        results.attempts.push({ contact_id: c.id, status: 'skipped', reason: 'no_matching_lead_with_sold_json' });
        continue;
      }

      const s = targetLead.sold || {};
      if (!s.policyNumber && !s.carrier && !s.monthlyPayment && !s.startDate) {
        results.attempts.push({ contact_id: c.id, lead_id: targetLead.id, status: 'skipped', reason: 'sold_json_missing_policy_fields' });
        continue;
      }

      const pmid = `sold_${targetLead.id}`;

      // Dedupe unless force
      if (!force) {
        const { data: existing } = await supabase
          .from('messages')
          .select('id')
          .eq('user_id', user_id)
          .eq('contact_id', c.id)
          .eq('provider_message_id', pmid)
          .limit(1);
        if (existing && existing.length) {
          results.attempts.push({ contact_id: c.id, lead_id: targetLead.id, status: 'skipped', reason: 'dedupe_exists', pmid });
          continue;
        }
      }

      try {
        const response = await sendTemplate({
          to: c.phone,
          user_id,
          provider_message_id: pmid,
          placeholders: {
            first_name: firstName(c.full_name, firstName(targetLead.name || '')),
            state: targetLead.state || c?.meta?.state || '',
            beneficiary: targetLead.beneficiary_name || targetLead.beneficiary || c?.meta?.beneficiary || '',
            carrier: s.carrier || '',
            policy_number: s.policyNumber || '',
            premium: s.premium || '',
            monthly_payment: s.monthlyPayment || '',
            policy_start_date: s.startDate || '',
            face_amount: s.faceAmount || '',
          },
        });
        results.attempts.push({ contact_id: c.id, lead_id: targetLead.id, status: 'sent', pmid, response });
        results.sent += 1;
        if (leadId) break; // if you targeted a specific lead, stop after sending once
      } catch (e) {
        results.attempts.push({ contact_id: c.id, lead_id: targetLead.id, status: 'error', error: e.message });
      }
    }
  }

  return { statusCode: 200, body: JSON.stringify(results, null, 2) };
};
