// File: netlify/functions/lead-new-auto.js
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const SITE_URL = process.env.SITE_URL || 'https://remiecrm.com';

const json = (obj, statusCode = 200) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
const supa = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);
const norm10 = (p) => String(p || '').replace(/\D/g, '').slice(-10);

export const handler = async (evt) => {
  const debug = new URLSearchParams(evt.rawQuery || '').get('debug') === '1';
  try {
    if (evt.httpMethod !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) return json({ error: 'server_misconfigured_supabase' }, 500);

    let body; try { body = JSON.parse(evt.body || '{}'); } catch { return json({ error: 'invalid_json' }, 400); }
    const lead_id = body.lead_id || body.id;
    if (!lead_id) return json({ error: 'missing_fields', need: ['lead_id'] }, 400);

    const db = supa();

    // 1) Load lead
    const { data: lead, error: lerr } = await db
      .from('leads')
      .select('id,user_id,name,phone,state,beneficiary,beneficiary_name')
      .eq('id', lead_id)
      .maybeSingle();
    if (lerr) return json({ error: 'lead_lookup_failed', detail: lerr.message }, 500);
    if (!lead) return json({ error: 'lead_not_found', lead_id }, 404);

    // 2) Find contact for this user + phone (your contact creation is already working)
    const { data: contacts } = await db
      .from('message_contacts')
      .select('id,phone,subscribed,tags')
      .eq('user_id', lead.user_id);

    const contact = (contacts || []).find(c => norm10(c.phone) === norm10(lead.phone));
    if (!contact) return json({ error: 'contact_not_found_for_lead_phone' }, 404);
    if (!contact.subscribed) return json({ error: 'contact_unsubscribed' }, 400);

    // 3) Choose template by tag (lead or military). Fallback to new_lead if new_military missing.
    const hasMilitary = (contact.tags || []).includes('military');
    const templateKey = hasMilitary ? 'new_military' : 'new_lead';
    const pmid = `${templateKey}_${lead.id}`;

    // 4) Call messages-send with lead_id only; it resolves placeholders/agent/etc.
    const res = await fetch(`${SITE_URL}/.netlify/functions/messages-send?debug=${debug ? '1' : '0'}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lead_id: lead.id,
        templateKey,
        provider_message_id: pmid,
        debug
      })
    });
    const text = await res.text(); let send; try { send = JSON.parse(text); } catch { send = { raw: text }; }

    return json({
      ok: res.ok,
      lead_id: lead.id,
      contact_id: contact.id,
      send_status: res.status,
      send
    }, res.ok ? 200 : 207);
  } catch (e) {
    return json({ error: 'unhandled', detail: String(e?.message || e) }, 500);
  }
};
