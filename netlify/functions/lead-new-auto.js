// File: netlify/functions/lead-new-auto.js
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const SITE_URL = process.env.SITE_URL || 'https://remiecrm.com';

const json = (obj, statusCode = 200) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(obj),
});

const supa = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);
const norm10 = (p) => String(p || '').replace(/\D/g, '').slice(-10);

export const handler = async (evt) => {
  const debug = new URLSearchParams(evt.rawQuery || '').get('debug') === '1';
  const trace = [];
  try {
    if (evt.httpMethod !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) return json({ error: 'server_misconfigured_supabase' }, 500);

    let body;
    try { body = JSON.parse(evt.body || '{}'); }
    catch { return json({ error: 'invalid_json' }, 400); }

    // expected payload (you can pass more, we’ll ignore the rest)
    const {
      user_id,
      name = '',
      phone,
      state = '',
      beneficiary = '',
      beneficiary_name = '',
      email = null,
      notes = null,
      military = false, // if you want to tag as 'military' instead of 'lead'
    } = body || {};

    if (!user_id || !phone) return json({ error: 'missing_fields', need: ['user_id','phone'] }, 400);
    const supabase = supa();

    // 1) UPSERT contact (subscribed, correct status tag)
    const statusTag = military ? 'military' : 'lead';
    const last10 = norm10(phone);
    trace.push({ step: 'contact.upsert.start', last10, statusTag });

    // find existing by last10
    const { data: contacts } = await supabase
      .from('message_contacts')
      .select('id, user_id, phone, tags, subscribed, full_name, meta')
      .eq('user_id', user_id);

    let contact = (contacts || []).find(c => norm10(c.phone) === last10) || null;

    if (contact) {
      const tags = Array.isArray(contact.tags) ? contact.tags : [];
      const newTags = [statusTag]; // exclusive tag per your rule
      const { data: updated, error: uerr } = await supabase
        .from('message_contacts')
        .update({
          full_name: contact.full_name || name || '',
          tags: newTags,
          subscribed: true,
          meta: { ...(contact.meta || {}), state, beneficiary: beneficiary_name || beneficiary || '' }
        })
        .eq('id', contact.id)
        .select('id, user_id, phone, tags, subscribed, full_name, meta')
        .maybeSingle();
      if (uerr) return json({ error: 'contact_update_failed', detail: uerr.message, trace: debug ? trace : undefined }, 500);
      contact = updated;
      trace.push({ step: 'contact.upsert.updated', contact_id: contact.id, tags: contact.tags });
    } else {
      const { data: inserted, error: ierr } = await supabase
        .from('message_contacts')
        .insert([{
          user_id, full_name: name || '', phone, subscribed: true,
          tags: [statusTag],
          meta: { state, beneficiary: beneficiary_name || beneficiary || '' }
        }])
        .select('id, user_id, phone, tags, subscribed, full_name, meta')
        .maybeSingle();
      if (ierr) return json({ error: 'contact_insert_failed', detail: ierr.message, trace: debug ? trace : undefined }, 500);
      contact = inserted;
      trace.push({ step: 'contact.upsert.inserted', contact_id: contact.id, tags: contact.tags });
    }

    // 2) INSERT a lead row (simple insert; your pipeline/trigger can adjust later)
    const { data: lead, error: lerr } = await supabase
      .from('leads')
      .insert([{
        user_id,
        status: 'lead',
        name,
        phone,
        email,
        notes,
        state,
        beneficiary,
        beneficiary_name
      }])
      .select('id, user_id, name, phone, state, beneficiary, beneficiary_name')
      .maybeSingle();
    if (lerr) return json({ error: 'lead_insert_failed', detail: lerr.message, trace: debug ? trace : undefined }, 500);
    trace.push({ step: 'lead.insert.ok', lead_id: lead.id });

    // 3) CALL messages-send with debug=1 so we get full server trace back
    const provider_message_id = `new_lead_${lead.id}`;
    const sendUrl = `${SITE_URL}/.netlify/functions/messages-send?debug=1`;
    const sendBody = {
      user_id,
      to: phone,
      templateKey: 'new_lead',
      provider_message_id,
      placeholders: {
        first_name: (name || '').split(/\s+/)[0] || '',
        state,
        beneficiary: beneficiary_name || beneficiary || ''
      },
      debug: true
    };

    trace.push({ step: 'send.request', url: sendUrl, provider_message_id, to: phone });
    const sendRes = await fetch(sendUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sendBody)
    });
    const sendText = await sendRes.text();
    let sendJson = null; try { sendJson = JSON.parse(sendText); } catch { sendJson = { raw: sendText }; }
    trace.push({ step: 'send.response', status: sendRes.status, ok: sendRes.ok });

    // 4) Return everything so you can see it in DevTools
    return json({
      ok: true,
      lead_id: lead.id,
      contact_id: contact.id,
      send: sendJson,        // includes messages-send trace when debug is on
      trace: debug ? trace : undefined
    }, 200);
  } catch (e) {
    return json({ error: 'unhandled', detail: String(e?.message || e), trace }, 500);
  }
};
