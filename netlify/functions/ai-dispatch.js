// netlify/functions/ai-dispatch.js
const { getServiceClient } = require('./_supabase');
const fetch = require('node-fetch');

exports.handler = async (event) => {
  const db = getServiceClient();
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch {}
  const { user_id, contact_id, from, to, text } = body || {};

  if (!user_id || !contact_id || !from) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'missing_fields' }) };
  }

  // Load contact + agent context
  const { data: contact } = await db.from('message_contacts')
    .select('id, subscribed, ai_booked, full_name')
    .eq('id', contact_id).maybeSingle();

  if (!contact || contact.subscribed === false || contact.ai_booked === true) {
    return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: true }) };
  }

  const { data: agent } = await db.from('agent_profiles')
    .select('full_name, calendly_url')
    .eq('user_id', user_id).maybeSingle();

  // Debounce (optional): check last AI send in 3–5 min window
  // const recent = await db.from('messages').select('id, created_at, meta')
  //   .eq('user_id', user_id).eq('to_number', from).eq('direction','outgoing')
  //   .order('created_at', { ascending:false }).limit(1);

  // Get reply from the brain
  const { decide } = require('./ai-brain');
  const out = decide({
    text,
    agentName: agent?.full_name || 'your licensed broker',
    calendlyLink: agent?.calendly_url || '',
    tz: process.env.AGENT_DEFAULT_TZ || 'America/Chicago',
    officeHours: { start: 9, end: 21 }, // 9am–9pm offers
  });

  if (!out || !out.text) {
    return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: true }) };
  }

  // Send via existing messages-send (so TFN/wallet/trace stay centralized)
  const sendUrl =
    process.env.SITE_URL
      ? `${process.env.SITE_URL}/.netlify/functions/messages-send`
      : '/.netlify/functions/messages-send';

  const res = await fetch(sendUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      to: from,                // lead number
      body: out.text,
      requesterId: user_id,
      sent_by_ai: true,
      provider_message_id: undefined,
      meta: { sent_by_ai: true, ai_intent: out.intent, ai_version: 'v1' }
    }),
  });
  const json = await res.json().catch(() => ({}));

  // If they gave a specific time, optionally mark the contact booked
  if (out.intent === 'confirm_time') {
    await db.from('message_contacts').update({ ai_booked: true }).eq('id', contact_id);
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true, send: json }) };
};
