// File: netlify/functions/automation-sold-debug.js
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

const supa = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);
const normalizePhone = (p) => {
  const d = String(p || '').replace(/\D/g, '');
  return d.length > 10 ? d.slice(-10) : d;
};

export const handler = async (evt) => {
  const supabase = supa();
  const qp = new URLSearchParams(evt.rawQuery || '');

  const userEmail = qp.get('user_email') || null; // optional
  const leadId = qp.get('lead_id') || null;       // optional single-lead drill
  const requireStatusSold = (qp.get('require_status_sold') ?? 'true') !== 'false';

  // Resolve user filter
  let userId = null;
  if (userEmail) {
    const { data: u } = await supabase
      .from('profiles')
      .select('id, email')
      .eq('email', userEmail)
      .maybeSingle();
    userId = u?.id || null;
  }

  // fetch subscribed contacts
  const { data: contacts } = await supabase
    .from('message_contacts')
    .select('id,user_id,full_name,phone,subscribed')
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

  const userIds = userId ? [userId] : Array.from(byUser.keys());
  if (!userIds.length) {
    return { statusCode: 200, body: JSON.stringify({ ok: true, reason: 'no_subscribed_contacts_found' }) };
  }

  // Fetch leads (sold JSON present, optionally status='sold')
  let q = supabase.from('leads')
    .select('id,user_id,name,phone,status,sold,updated_at')
    .in('user_id', userIds)
    .not('sold', 'is', null);

  if (requireStatusSold) q = q.eq('status', 'sold');
  if (leadId) q = q.eq('id', leadId);

  const { data: leads, error: lErr } = await q;
  if (lErr) return { statusCode: 500, body: JSON.stringify({ ok: false, error: lErr.message }) };

  const results = { ok: true, analyzed: leads?.length || 0, ready: [], skipped: [] };

  for (const l of leads || []) {
    const p = normalizePhone(l.phone);
    const contact = phoneMapByUser.get(l.user_id)?.get(p);

    const pmid = `sold_${l.id}`;
    const { data: existing } = await supabase
      .from('messages')
      .select('id')
      .eq('user_id', l.user_id)
      .eq('contact_id', contact?.id || '00000000-0000-0000-0000-000000000000')
      .eq('provider_message_id', pmid)
      .limit(1);

    if (!contact) {
      results.skipped.push({ lead_id: l.id, reason: 'no_matching_contact_by_phone', phone: l.phone });
      continue;
    }
    if (existing && existing.length) {
      results.skipped.push({ lead_id: l.id, contact_id: contact.id, reason: 'dedupe_already_sent', provider_message_id: pmid });
      continue;
    }
    if (!l.sold) {
      results.skipped.push({ lead_id: l.id, contact_id: contact.id, reason: 'sold_json_missing' });
      continue;
    }
    if (requireStatusSold && l.status !== 'sold') {
      results.skipped.push({ lead_id: l.id, contact_id: contact.id, reason: 'status_not_sold', status: l.status });
      continue;
    }

    results.ready.push({
      lead_id: l.id,
      contact_id: contact.id,
      pmid,
      preview_vars: {
        first_name: (contact.full_name || l.name || '').split(/\s+/)[0] || '',
        carrier: l.sold?.carrier || '',
        policy_number: l.sold?.policyNumber || '',
        monthly_payment: l.sold?.monthlyPayment || '',
      }
    });
  }

  return { statusCode: 200, body: JSON.stringify(results, null, 2) };
};
