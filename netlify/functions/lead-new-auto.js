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
  const trace = [];
  try {
    if (evt.httpMethod !== 'POST') return json({ error: 'method_not_allowed', trace }, 405);
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) return json({ error: 'server_misconfigured_supabase', trace }, 500);

    let body; try { body = JSON.parse(evt.body || '{}'); } catch { return json({ error: 'invalid_json', trace }, 400); }
    const lead_id = body.lead_id || body.id;
    if (!lead_id) return json({ error: 'missing_fields', need: ['lead_id'], trace }, 400);

    const db = supa();

    // 1) Load lead (owner + phone)
    const { data: lead, error: lerr } = await db
      .from('leads')
      .select('id,user_id,name,phone,state,beneficiary,beneficiary_name')
      .eq('id', lead_id)
      .maybeSingle();
    if (lerr) return json({ error: 'lead_lookup_failed', detail: lerr.message, trace }, 500);
    if (!lead) return json({ error: 'lead_not_found', lead_id, trace }, 404);
    trace.push({ step: 'lead.loaded', lead_id: lead.id, user_id: lead.user_id });

    // 2) Find the contact that was created for this lead (you said this is working)
    const { data: contacts, error: cerr } = await db
      .from('message_contacts')
      .select('id,phone,subscribed,tags')
      .eq('user_id', lead.user_id);
    if (cerr) return json({ error: 'contact_list_failed', detail: cerr.message, trace }, 500);

    const contact = (contacts || []).find((c) => norm10(c.phone) === norm10(lead.phone)) || null;
    if (!contact) return json({ error: 'contact_not_found_for_lead_phone', trace }, 404);
    if (!contact.subscribed) return json({ error: 'contact_unsubscribed', contact_id: contact.id, trace }, 400);
    trace.push({ step: 'contact.matched', contact_id: contact.id, tags: contact.tags || [] });

    // 3) Choose template by tag
    const hasMilitary = (contact.tags || []).includes('military');
    const templateKey = hasMilitary ? 'new_military' : 'new_lead';
    const provider_message_id = `${templateKey}_${lead.id}`;
    trace.push({ step: 'template.choose', templateKey, provider_message_id });

    // 4) Call messages-send (it ALWAYS returns a trace)
    const sendRes = await fetch(`${SITE_URL}/.netlify/functions/messages-send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lead_id,
        templateKey,
        provider_message_id
      })
    });
    const sendText = await sendRes.text();
    let sendJson = null; try { sendJson = JSON.parse(sendText); } catch { sendJson = { raw: sendText }; }

    // 5) Bubble the inner sender response back to the browser (so you see it in Network/Console)
    return json({
      ok: sendRes.ok,
      lead_id,
      contact_id: contact.id,
      send_status: sendRes.status,
      send: sendJson,  // includes messages-send trace
      trace
    }, sendRes.ok ? 200 : 207);     // 207 so you still see body on failure

  } catch (e) {
    return json({ error: 'unhandled', detail: String(e?.message || e), trace }, 500);
  }
};
