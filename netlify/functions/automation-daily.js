// File: netlify/functions/automation-daily.js
import { DateTime } from 'luxon';
import { createClient } from '@supabase/supabase-js';

export const config = {
  // 15:00 UTC ≈ 10:00 AM America/Chicago (DST-aware)
  schedule: '0 15 * * *',
};

const TZ = 'America/Chicago';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const SITE_URL = process.env.SITE_URL || 'https://remiecrm.com';

const supa = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

function todayCH() { return DateTime.now().setZone(TZ); }
function firstName(full = '', fallback = '') {
  const n = String(full || '').trim();
  return n ? n.split(/\s+/)[0] : (fallback || '');
}
function normalizePhone(p) {
  const digits = String(p || '').replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits; // match last 10
}

/** Parse 'YYYY-MM-DD' or 'MM/DD/YYYY' or 'MM-DD-YYYY' */
function parseDOB(raw) {
  if (!raw) return null;
  const s = String(raw).trim();

  let dt = DateTime.fromISO(s, { zone: TZ });
  if (dt.isValid) return dt;

  for (const fmt of ['MM/dd/yyyy', 'M/d/yyyy', 'MM-dd-yyyy', 'M-d-yyyy']) {
    dt = DateTime.fromFormat(s, fmt, { zone: TZ });
    if (dt.isValid) return dt;
  }
  return null;
}

function isBirthdayToday(dobStr, today) {
  const dt = parseDOB(dobStr);
  if (!dt) return false;
  return dt.toFormat('MM-dd') === today.toFormat('MM-dd');
}

/** Supported holidays (MLK removed; Halloween added) */
function holidayFor(dt) {
  const md = dt.toFormat('MM-dd');

  // Fixed-date
  const fixed = {
    '01-01': { key: 'new_year', label: "New Year's Day" },
    '07-04': { key: 'independence_day', label: 'Independence Day' },
    '10-31': { key: 'halloween', label: 'Halloween' },
    '11-11': { key: 'veterans_day', label: 'Veterans Day' },
    '12-25': { key: 'christmas', label: 'Christmas Day' },
  };
  if (fixed[md]) return fixed[md];

  // Floating
  const nthWeekday = (month, wkday, nth) =>
    DateTime.fromObject({ year: dt.year, month, day: 1, zone: TZ })
      .plus({
        days:
          ((wkday - DateTime.fromObject({ year: dt.year, month, day: 1, zone: TZ }).weekday + 7) % 7) +
          7 * (nth - 1),
      });
  const lastWeekday = (month, wkday) => {
    const end = DateTime.fromObject({ year: dt.year, month, day: 1, zone: TZ }).endOf('month');
    const offset = (end.weekday - wkday + 7) % 7;
    return end.minus({ days: offset });
  };

  if (dt.hasSame(lastWeekday(5, 1), 'day')) return { key: 'memorial_day', label: 'Memorial Day' }; // last Mon May
  if (dt.hasSame(nthWeekday(9, 1, 1), 'day')) return { key: 'labor_day', label: 'Labor Day' };     // 1st Mon Sep
  if (dt.hasSame(nthWeekday(11, 4, 4), 'day'))return { key: 'thanksgiving', label: 'Thanksgiving' };// 4th Thu Nov

  return null;
}

async function fetchTemplates(supabase, user_id) {
  const { data, error } = await supabase
    .from('message_templates')
    .select('templates')
    .eq('user_id', user_id)
    .maybeSingle();
  if (error || !data) return {};
  return data.templates || {};
}

async function fetchAgent(supabase, user_id) {
  const { data, error } = await supabase
    .from('agent_profiles')
    .select('full_name, phone, calendly_url')
    .eq('user_id', user_id)
    .maybeSingle();
  if (error || !data) return {};
  return data;
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
      client_ref: provider_message_id,   // hooks into your provider_message_id dedupe
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

  // 1) All subscribed contacts
  const { data: contacts, error: cErr } = await supabase
    .from('message_contacts')
    .select('id,user_id,full_name,phone,tags,subscribed,meta')
    .eq('subscribed', true);
  if (cErr) {
    console.error('contacts fetch error', cErr);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'contacts_fetch_failed' }) };
  }

  // Build indices
  const byUser = new Map();             // user_id -> contacts[]
  const phoneMapByUser = new Map();     // user_id -> Map(normalizedPhone -> contact)
  const userIds = new Set();

  for (const c of contacts || []) {
    if (!c.phone) continue;
    userIds.add(c.user_id);
    if (!byUser.has(c.user_id)) {
      byUser.set(c.user_id, []);
      phoneMapByUser.set(c.user_id, new Map());
    }
    byUser.get(c.user_id).push(c);
    phoneMapByUser.get(c.user_id).set(normalizePhone(c.phone), c);
  }

  // 2) Leads for those users (only ones with DOB present)
  let leads = [];
  if (userIds.size) {
    const { data: lrows, error: lErr } = await supabase
      .from('leads')
      .select('id,user_id,name,phone,dob,state,beneficiary,beneficiary_name,created_at')
      .in('user_id', Array.from(userIds))
      .not('dob', 'is', null);
    if (lErr) {
      console.error('leads fetch error', lErr);
    } else {
      leads = lrows || [];
    }
  }

  // Build a quick lead lookup by (user, phone) prefer latest created_at
  const leadByUserPhone = new Map(); // key: `${user_id}:${normPhone}` -> lead
  for (const l of leads) {
    const key = `${l.user_id}:${normalizePhone(l.phone)}`;
    const prev = leadByUserPhone.get(key);
    if (!prev || DateTime.fromISO(l.created_at) > DateTime.fromISO(prev.created_at)) {
      leadByUserPhone.set(key, l);
    }
  }

  let sent = 0;

  // 3) Per-user processing
  for (const user_id of userIds) {
    const templates = await fetchTemplates(supabase, user_id);
    const agent = await fetchAgent(supabase, user_id);
    const agentVars = {
      agent_name: agent?.full_name || '',
      agent_phone: agent?.phone || '',
      calendly_link: agent?.calendly_url || '',
    };
    const contactsList = byUser.get(user_id) || [];
    const phoneMap = phoneMapByUser.get(user_id) || new Map();

    // 3a) Holiday blast (to all subscribed contacts)
    const h = holidayFor(today);
    if (h && templates.holiday_text) {
      const pmid = `holiday_${h.key}_${ymd}`;
      for (const c of contactsList) {
        try {
          const key = `${user_id}:${normalizePhone(c.phone)}`;
          const l = leadByUserPhone.get(key);
          const placeholders = {
            ...agentVars,
            first_name: firstName(c.full_name, firstName(l?.name || '')),
            state: l?.state || c?.meta?.state || '',
            beneficiary: l?.beneficiary_name || l?.beneficiary || c?.meta?.beneficiary || '',
          };
          await sendTemplate({
            to: c.phone, user_id,
            templateKey: 'holiday_text',
            provider_message_id: pmid,
            placeholders,
          });
          sent++;
        } catch (e) {
          console.warn('holiday send failed', user_id, c.id, e.message);
        }
      }
    }

    // 3b) Birthdays from LEADS (join by phone)
    if (templates.birthday_text) {
      // Filter this user's leads that have a birthday today
      const todaysLeads = (leads || []).filter(
        (l) => l.user_id === user_id && isBirthdayToday(l.dob, today)
      );

      for (const l of todaysLeads) {
        const contact = phoneMap.get(normalizePhone(l.phone));
        if (!contact) continue;                // must map to an existing subscribed contact
        if (!contact.phone) continue;

        const pmid = `birthday_${ymd}_${contact.id}`;
        try {
          const placeholders = {
            ...agentVars,
            first_name: firstName(contact.full_name, firstName(l.name || '')),
            state: l.state || contact?.meta?.state || '',
            beneficiary: l.beneficiary_name || l.beneficiary || contact?.meta?.beneficiary || '',
          };
          await sendTemplate({
            to: contact.phone, user_id,
            templateKey: 'birthday_text',
            provider_message_id: pmid,
            placeholders,
          });
          sent++;
        } catch (e) {
          console.warn('birthday send failed', user_id, contact.id, e.message);
        }
      }
    }

    // 3c) Payment reminder block unchanged (still uses contact meta if you use it)
    if (templates.payment_reminder) {
      for (const c of contactsList) {
        const today = todayCH(); // re-evaluate in loop to be safe
        const dueDay = c?.meta?.payment_due_day; // 1..28
        const dueDate = c?.meta?.payment_due_date; // 'YYYY-MM-DD'
        const isDue =
          (typeof dueDay === 'number' && dueDay === today.day) ||
          (typeof dueDay === 'string' && Number(dueDay) === today.day) ||
          (typeof dueDate === 'string' && dueDate === today.toFormat('yyyy-LL-dd'));

        if (!isDue) continue;

        const key = `${user_id}:${normalizePhone(c.phone)}`;
        const l = leadByUserPhone.get(key);
        const pmid = `payment_${ymd}_${c.id}`;
        try {
          const placeholders = {
            ...agentVars,
            first_name: firstName(c.full_name, firstName(l?.name || '')),
            state: l?.state || c?.meta?.state || '',
            beneficiary: l?.beneficiary_name || l?.beneficiary || c?.meta?.beneficiary || '',
          };
          await sendTemplate({
            to: c.phone, user_id,
            templateKey: 'payment_reminder',
            provider_message_id: pmid,
            placeholders,
          });
          sent++;
        } catch (e) {
          console.warn('payment send failed', user_id, c.id, e.message);
        }
      }
    }
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true, sent }) };
};
