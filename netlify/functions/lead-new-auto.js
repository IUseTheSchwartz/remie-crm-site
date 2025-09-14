// File: netlify/functions/lead-new-auto.js
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const SITE_URL = process.env.SITE_URL || 'https://remiecrm.com';

const json = (obj, statusCode = 200) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
const supa = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);
const norm10 = (p) => String(p || '').replace(/\D/g, '').slice(-10);

async function resolveUserId(db, { user_id, user_email, debug }) {
  if (user_id) return user_id;
  if (user_email) {
    const { data: u } = await db.from('profiles').select('id,email').eq('email', user_email).maybeSingle();
    if (u?.id) return u.id;
  }
  if (debug) {
    const tester = 'jacobprieto@gmail.com';
    const { data: u } = await db.from('profiles').select('id,email').eq('email', tester).maybeSingle();
    if (u?.id) return u.id;
  }
  return null;
}

export const handler = async (evt) => {
  const debug = new URLSearchParams(evt.rawQuery || '').get('debug') === '1';
  const trace = [];
  try {
    if (evt.httpMethod !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) return json({ error: 'server_misconfigured_supabase' }, 500);

    let body; try { body = JSON.parse(evt.body || '{}'); } catch { return json({ error: 'invalid_json' }, 400); }
    const { user_id: rawUid, user_email, name = '', phone, state = '', beneficiary = '', beneficiary_name = '', email = null, notes = null, military = false } = body || {};
    if (!phone) return json({ error: 'missing_fields', need: ['phone'] }, 400);

    const db = supa();
    const user_id = await resolveUserId(db, { user_id: rawUid, user_email, debug });
    if (!user_id) return json({ error: 'missing_fields', need: ['user_id or user_email'], tip: 'Pass user_email in dev if easier' }, 400);
    trace.push({ step: 'user.resolve.ok', user_id });

    // Upsert contact (exclusive tag: lead or military)
    const statusTag = military ? 'military' : 'lead';
    const last10 = norm10(phone);
    const { data: contacts } = await db.from('message_contacts').select('id,user_id,phone,tags,subscribed,full_name,meta').eq('user_id', user_id);
    let contact = (contacts || []).find(c => norm10(c.phone) === last10) || null;

    if (contact) {
      const { data: updated, error: uerr } = await db.from('message_contacts').update({
        full_name: contact.full_name || name || '', tags: [statusTag], subscribed: true,
        meta: { ...(contact.meta || {}), state, beneficiary: beneficiary_name || beneficiary || '' }
      }).eq('id', contact.id).select('id,user_id,phone,tags,subscribed,full_name,meta').maybeSingle();
      if (uerr) return json({ error: 'contact_update_failed', detail: uerr.message }, 500);
      contact = updated; trace.push({ step: 'contact.updated', contact_id: contact.id });
    } else {
      const { data: inserted, error: ierr } = await db.from('message_contacts').insert([{
        user_id, full_name: name || '', phone, subscribed: true, tags: [statusTag],
        meta: { state, beneficiary: beneficiary_name || beneficiary || '' }
      }]).select('id,user_id,phone,tags,subscribed,full_name,meta').maybeSingle();
      if (ierr) return json({ error: 'contact_insert_failed', detail: ierr.message }, 500);
      contact = inserted; trace.push({ step: 'contact.inserted', contact_id: contact.id });
    }

    // Insert lead
    const { data: lead, error: lerr } = await db.from('leads').insert([{
      user_id, status: 'lead', name, phone, email, notes, state, beneficiary, beneficiary_name
    }]).select('id,user_id,name,phone,state,beneficiary,beneficiary_name').maybeSingle();
    if (lerr) return json({ error: 'lead_insert_failed', detail: lerr.message }, 500);
    trace.push({ step: 'lead.insert.ok', lead_id: lead.id });

    // Call messages-send using lead_id (server will resolve user/to/vars)
    const sendRes = await fetch(`${SITE_URL}/.netlify/functions/messages-send?debug=1`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lead_id: lead.id,
        templateKey: 'new_lead',
        provider_message_id: `new_lead_${lead.id}`,
        debug: true
      })
    });
    const sendText = await sendRes.text(); let sendJson; try { sendJson = JSON.parse(sendText); } catch { sendJson = { raw: sendText }; }

    return json({
      ok: sendRes.ok, lead_id: lead.id, contact_id: contact.id,
      send_status: sendRes.status, send: sendJson, trace: debug ? trace : undefined
    }, sendRes.ok ? 200 : 207);
  } catch (e) {
    return json({ error: 'unhandled', detail: String(e?.message || e), trace }, 500);
  }
};
