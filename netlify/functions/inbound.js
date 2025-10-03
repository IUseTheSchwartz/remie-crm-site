// netlify/functions/inbound.js
// Zapier Sheets → RemieCRM ingest
// - Auth: expects a Remie "connection" that can provide user context on every Zap call.
//   We accept one of:
//     (a) body.requesterId (preferred: your Zapier OAuth connection stores user_id)
//     (b) Authorization: Bearer <JWT> (Supabase user JWT; rare if calling from your app)
//     (c) X-Remie-User-Id: <uuid>  (simple API key style you can wire in your Zap action)
//
// - Behavior: normalize → upsert into leads → upsert message_contacts → send "new lead" SMS
//   (wallet-gated, TFN-verified, idempotent). Mirrors your previous gsheet-webhook behavior,
//   but WITHOUT per-user webhooks or Apps Script.

const crypto = require("crypto");
const fetch = require("node-fetch");
const { getServiceClient, getUserFromRequest } = require("./_supabase");

const supabase = getServiceClient();

/* ----------------------------- small utils ----------------------------- */
const S = (v) => (v == null ? "" : String(v).trim());
const U = (v) => {
  const s = S(v);
  return s === "" ? undefined : s;
};

// --- Normalize any date-like input to MM/DD/YYYY
function toMDY(v) {
  if (v == null) return undefined;
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    const mm = String(v.getMonth() + 1).padStart(2, "0");
    const dd = String(v.getDate()).padStart(2, "0");
    const yy = v.getFullYear();
    return `${mm}/${dd}/${yy}`;
  }
  const s = String(v).trim();
  if (!s) return undefined;
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const [, y, m, d] = iso;
    return `${m}/${d}/${y}`;
  }
  const us = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (us) {
    let mm = parseInt(us[1], 10);
    let dd = parseInt(us[2], 10);
    let yy = us[3];
    if (yy.length === 2) yy = (yy >= "50" ? "19" : "20") + yy;
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
      return `${String(mm).padStart(2, "0")}/${String(dd).padStart(2, "0")}/${yy}`;
    }
  }
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) {
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const yy = d.getFullYear();
    return `${mm}/${dd}/${yy}`;
  }
  return undefined;
}

const onlyDigits = (s) => String(s || "").replace(/\D/g, "");
const normalizeTag = (s) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, "_");
const uniqTags = (arr) => Array.from(new Set((arr || []).map(normalizeTag))).filter(Boolean);

function toE164(p) {
  const d = onlyDigits(p);
  if (!d) return null;
  if (d.startsWith("1") && d.length === 11) return `+${d}`;
  if (d.length === 10) return `+1${d}`;
  if (String(p || "").startsWith("+")) return String(p);
  return null;
}

/* ------------------------ contact tag helpers ------------------------ */
function normalizePhone(s) {
  const d = onlyDigits(s);
  return d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
}
function phoneVariants(raw) {
  const d = onlyDigits(raw);
  const e = toE164(raw);
  const variants = new Set([raw, d, e].filter(Boolean));
  if (d.length === 11 && d.startsWith("1")) variants.add(d.slice(1));
  if (d.length === 10) {
    variants.add("1" + d);
    variants.add("+1" + d);
  }
  return Array.from(variants);
}
async function findContactByPhone(user_id, phone) {
  const vars = phoneVariants(phone);
  const { data, error } = await supabase
    .from("message_contacts")
    .select("id, phone, full_name, tags, meta")
    .eq("user_id", user_id)
    .in("phone", vars)
    .limit(1);
  if (error) throw error;
  return data?.[0] || null;
}
async function upsertContactByUserPhone({ user_id, phone, full_name, tags, meta = {} }) {
  const cleanTags = Array.isArray(tags) ? tags.filter(Boolean).map(String) : [];
  const phoneE164 = toE164(phone) || phone;
  const existing = await findContactByPhone(user_id, phone);
  if (existing?.id) {
    const mergedMeta = { ...(existing.meta || {}), ...(meta || {}) };
    const { error: uErr } = await supabase
      .from("message_contacts")
      .update({
        phone: phoneE164,
        full_name: full_name || existing.full_name || null,
        tags: cleanTags,
        meta: mergedMeta,
      })
      .eq("id", existing.id);
    if (uErr) throw uErr;
    return existing.id;
  } else {
    const { data: ins, error: iErr } = await supabase
      .from("message_contacts")
      .insert([{ user_id, phone: phoneE164, full_name: full_name || null, subscribed: true, tags: cleanTags, meta }])
      .select("id")
      .single();
    if (iErr) throw iErr;
    return ins.id;
  }
}
async function computeNextContactTags({ user_id, phone, full_name, military_branch }) {
  const phoneNorm = normalizePhone(phone);
  const { data: candidates, error } = await supabase
    .from("message_contacts")
    .select("id, phone, tags")
    .eq("user_id", user_id);
  if (error) throw error;
  const found = (candidates || []).find((c) => normalizePhone(c.phone) === phoneNorm);
  const current = Array.isArray(found?.tags) ? found.tags : [];
  const withoutStatus = current.filter((t) => !["lead", "military"].includes(normalizeTag(t)));
  const status = S(military_branch) ? "military" : "lead";
  const next = uniqTags([...withoutStatus, status]);
  return { contactId: found?.id ?? null, tags: next };
}

/* ------------------------ wallet + telnyx + send ------------------------ */

// Reuse your template mapping for military vs default
const TAG_TEMPLATE_MAP = { military: "new_lead_military" };

function renderTemplate(tpl, ctx) {
  return String(tpl || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, k) => S(ctx[k]));
}
function softenContent(text) {
  if (!text) return text;
  let out = String(text);
  out = out.replace(/\b(\d{3})(\d{3})(\d{4})\b/g, "+1 $1-$2-$3");
  if (!/stop to opt out/i.test(out)) out = out.trim() + " Reply STOP to opt out.";
  if (out.length > 500) out = out.slice(0, 500);
  return out;
}
async function alreadySentRecently(userId, toNumberE164, minutes = 10) {
  const since = new Date(Date.now() - minutes * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("messages")
    .select("id")
    .eq("user_id", userId)
    .eq("direction", "outgoing")
    .eq("to_number", toNumberE164)
    .gte("created_at", since)
    .limit(1);
  if (error) return false;
  return data && data.length > 0;
}
async function getBalanceCents(userId) {
  try {
    const { data, error } = await supabase
      .from("user_wallets")
      .select("balance_cents")
      .eq("user_id", userId)
      .single();
    if (error) throw error;
    const n = Number(data?.balance_cents ?? 0);
    if (!Number.isNaN(n)) return Math.floor(n);
  } catch (e) {
    console.error("[inbound] getBalanceCents failed:", e.message || e);
  }
  return 0;
}
async function getAgentTFN(userId) {
  const { data } = await supabase
    .from("agent_messaging_numbers")
    .select("e164, status")
    .eq("user_id", userId)
    .eq("status", "active")
    .limit(1);
  return data?.[0]?.e164 || null;
}
function getMessagingProfileId() {
  return process.env.TELNYX_MESSAGING_PROFILE_ID || null;
}
async function telnyxSendSMS({ to, text, from }) {
  const body = { to, text };
  const profile = getMessagingProfileId();
  if (profile) body.messaging_profile_id = profile;
  if (from) body.from = from;
  const resp = await fetch("https://api.telnyx.com/v2/messages", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await resp.json().catch(() => ({}));
  return { ok: resp.ok, status: resp.status, json };
}
async function telnyxGetMessage(messageId) {
  const resp = await fetch(`https://api.telnyx.com/v2/messages/${encodeURIComponent(messageId)}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}` },
  });
  const json = await resp.json().catch(() => ({}));
  return { ok: resp.ok, status: resp.status, json };
}
function mapTelnyxStatus(raw) {
  const s = String(raw || "").toLowerCase();
  if (s.includes("delivered")) return "delivered";
  if (s === "sent" || s === "accepted" || s.includes("queued") || s.includes("sending")) return "sent";
  if (s.includes("undeliverable") || s.includes("delivery_failed") || s.includes("failed") || s.includes("rejected")) return "error";
  return "sent";
}
async function chooseTemplateKey({ userId, contactId, lead }) {
  let key = "new_lead";
  if (S(lead.military_branch)) return TAG_TEMPLATE_MAP.military || key;
  try {
    if (contactId) {
      const { data: c } = await supabase
        .from("message_contacts")
        .select("tags")
        .eq("id", contactId)
        .single();
      const tags = Array.isArray(c?.tags) ? c.tags.map((t) => String(t).toLowerCase()) : [];
      for (const t of tags) {
        const mapped = TAG_TEMPLATE_MAP[normalizeTag(t)];
        if (mapped) return mapped;
      }
    }
  } catch {}
  return key;
}

async function trySendNewLeadText({ userId, leadId, contactId, lead, providerMessageKey }) {
  if (!S(lead.phone)) return { ok: false, reason: "missing_phone" };
  const to = toE164(lead.phone);
  if (!to) return { ok: false, reason: "invalid_phone", detail: lead.phone };

  const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
  const TELNYX_MESSAGING_PROFILE_ID = getMessagingProfileId();
  const fromTFN = await getAgentTFN(userId);
  if (!TELNYX_API_KEY || !TELNYX_MESSAGING_PROFILE_ID || !fromTFN) {
    return {
      ok: false,
      reason: "no_agent_tfn_configured",
      detail: {
        have_api_key: !!TELNYX_API_KEY,
        have_profile: !!TELNYX_MESSAGING_PROFILE_ID,
        have_from_number: !!fromTFN,
      },
    };
  }

  const template_key = await chooseTemplateKey({ userId, contactId, lead });
  const { data: trow, error: terr } = await supabase
    .from("message_templates")
    .select("templates")
    .eq("user_id", userId)
    .single();
  if (terr) return { ok: false, reason: "template_load_error", detail: terr.message };

  const tpl = trow?.templates?.[template_key];
  if (!tpl) return { ok: false, reason: "template_not_found", template_key };

  const { data: agent, error: aerr } = await supabase
    .from("agent_profiles")
    .select("full_name, phone, calendly_url")
    .eq("user_id", userId)
    .single();
  if (aerr) return { ok: false, reason: "agent_profile_missing", detail: aerr.message };

  const COST_CENTS = 1;
  const balance = await getBalanceCents(userId);
  if (balance < COST_CENTS) return { ok: false, reason: "insufficient_balance", balance_cents: balance };

  if (await alreadySentRecently(userId, to, 10)) {
    return { ok: true, skipped: true, reason: "already_sent_recently" };
  }

  const beneficiary_name = S(lead.beneficiary_name) || S(lead.beneficiary);
  const vars = {
    first_name: S(lead.name).split(" ")[0] || "",
    agent_name: agent?.full_name || "",
    agent_phone: agent?.phone || "",
    calendly_link: agent?.calendly_url || "",
    state: S(lead.state),
    beneficiary: beneficiary_name,
    beneficiary_name,
    military_branch: S(lead.military_branch) || "",
    branch: S(lead.military_branch) || "",
    service_branch: S(lead.military_branch) || "",
  };
  let text = renderTemplate(tpl, vars);
  text = softenContent(text);

  const dedupeKey = providerMessageKey || `lead:${leadId || "n/a"}:tpl:${template_key}`;

  // pre-insert queued
  const preRow = {
    user_id: userId,
    contact_id: contactId || null,
    lead_id: leadId || null,
    provider: "telnyx",
    direction: "outgoing",
    from_number: fromTFN,
    to_number: to,
    body: text,
    status: "queued",
    segments: 1,
    price_cents: COST_CENTS,
    channel: "sms",
    provider_message_id: dedupeKey,
  };
  const { data: inserted, error: preErr } = await supabase
    .from("messages")
    .insert(preRow)
    .select("id")
    .single();
  if (preErr) {
    if ((preErr.message || "").toLowerCase().includes("duplicate")) {
      return { ok: true, skipped: true, reason: "deduped_on_insert", provider_message_id: dedupeKey };
    }
    return { ok: false, reason: "preinsert_failed", detail: preErr.message };
  }
  const messageId = inserted.id;

  // send
  try {
    const send = await telnyxSendSMS({ to, text, from: fromTFN });
    if (!send.ok) {
      await supabase
        .from("messages")
        .update({ status: "error", error_detail: JSON.stringify(send.json).slice(0, 1000) })
        .eq("id", messageId);
      return { ok: false, reason: "telnyx_error", telnyx: send.json, message_id: messageId };
    }

    const providerId = send.json?.data?.id || null;
    await supabase.from("messages").update({ status: providerId ? "sent" : "error", provider_sid: providerId }).eq("id", messageId);

    // one quick poll
    if (providerId) {
      try {
        const getRes = await telnyxGetMessage(providerId);
        const payload = getRes.json?.data || {};
        let statusRaw = payload?.to?.[0]?.status || payload?.delivery_status || payload?.status || "";
        if (!statusRaw) {
          await new Promise((r) => setTimeout(r, 1500));
          const getRes2 = await telnyxGetMessage(providerId);
          const payload2 = getRes2.json?.data || {};
          statusRaw = payload2?.to?.[0]?.status || payload2?.delivery_status || payload2?.status || "";
        }
        const mapped = mapTelnyxStatus(statusRaw);
        const detail = { polled: true, provider_sid: providerId, statusRaw: statusRaw || "(empty)" };
        const updates = { error_detail: JSON.stringify(detail).slice(0, 1000) };
        if (mapped === "error") updates.status = "error";
        if (mapped === "delivered") updates.status = "delivered";
        await supabase.from("messages").update(updates).eq("id", messageId);
      } catch {}
    }

    return { ok: true, telnyx_ok: true, provider_message_id: dedupeKey, provider_sid: providerId, message_id: messageId };
  } catch (e) {
    await supabase.from("messages").update({ status: "error", error_detail: String(e?.message || e).slice(0, 1000) }).eq("id", messageId);
    return { ok: false, reason: "telnyx_request_failed", detail: e?.message, message_id: messageId };
  }
}

/* ------------------------------- handler ------------------------------- */
exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

    // Parse body early
    let p;
    try {
      p = JSON.parse(event.body || "{}");
    } catch {
      return { statusCode: 400, body: "Invalid JSON" };
    }

    // Identify user_id:
    // 1) prefer body.requesterId (Zapier connection stores user_id)
    // 2) fallback to Bearer JWT (if present)
    // 3) or X-Remie-User-Id header for simple API key style
    let user_id = S(p.requesterId) || S(p.user_id);
    if (!user_id) {
      const authUser = await getUserFromRequest(event);
      if (authUser?.id) user_id = authUser.id;
    }
    if (!user_id) {
      const hdr = event.headers["x-remie-user-id"] || event.headers["X-Remie-User-Id"];
      if (hdr) user_id = S(hdr);
    }
    if (!user_id) return { statusCode: 401, body: JSON.stringify({ error: "missing_user_context" }) };

    const nowIso = new Date().toISOString();
    const lead = {
      user_id,
      name: U(p.name) ?? null,
      phone: U(p.phone) ?? null,
      email: U(p.email) ?? null,
      state: U(p.state) ?? null,
      created_at: U(p.created_at) || nowIso,

      stage: "no_pickup",
      stage_changed_at: nowIso,
      priority: "medium",
      call_attempts: 0,
      last_outcome: "",
      pipeline: {},
      military_branch: U(p.military_branch) ?? null,
    };

    const extras = {
      notes: U(p.notes),
      beneficiary: U(p.beneficiary),
      beneficiary_name: U(p.beneficiary_name),
      beneficiary_relation: U(p.beneficiary_relation),
      company: U(p.company),
      gender: U(p.gender),
    };
    const dobMDY = toMDY(p.dob);
    if (dobMDY) extras.dob = dobMDY;
    for (const [k, v] of Object.entries(extras)) if (v !== undefined) lead[k] = v;

    if (!lead.name && !lead.phone && !lead.email) {
      return { statusCode: 400, body: "Empty lead payload" };
    }

    // --------- DEDUPE guard (10 min window on phone/email) ---------
    const orFilters = [];
    if (lead.email) orFilters.push(`email.eq.${encodeURIComponent(lead.email)}`);
    if (lead.phone) orFilters.push(`phone.eq.${encodeURIComponent(lead.phone)}`);
    if (orFilters.length) {
      const cutoffISO = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const { data: existing, error: qErr } = await supabase
        .from("leads")
        .select("id, created_at")
        .eq("user_id", user_id)
        .gte("created_at", cutoffISO)
        .or(orFilters.join(","))
        .limit(1);
      if (!qErr && existing && existing.length) {
        const dupId = existing[0].id;
        // upsert contact meta even if dup
        try {
          if (lead.phone) {
            const { tags } = await computeNextContactTags({
              user_id,
              phone: lead.phone,
              full_name: lead.name,
              military_branch: lead.military_branch,
            });
            const beneficiary_name = S(lead.beneficiary_name) || S(lead.beneficiary) || "";
            await upsertContactByUserPhone({
              user_id,
              phone: lead.phone,
              full_name: lead.name,
              tags,
              meta: { beneficiary: beneficiary_name, lead_id: dupId },
            });
          }
        } catch (err) {
          console.error("[inbound] contact sync on dup failed:", err);
        }
        return {
          statusCode: 200,
          body: JSON.stringify({ ok: true, id: dupId, deduped: true, skipped: true, reason: "duplicate_lead_no_send" }),
        };
      }
    }

    // Insert lead
    const { data, error: insErr } = await supabase.from("leads").insert([lead]).select("id").single();
    if (insErr) {
      if (insErr.code === "23505") {
        return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: true, reason: "duplicate_lead_insert" }) };
      }
      console.error("[inbound] insert error:", insErr);
      return { statusCode: 500, body: JSON.stringify({ ok: false, error: insErr }) };
    }
    const insertedId = data?.id || null;

    // Upsert contact before sending
    let contactId = null;
    try {
      if (lead.phone) {
        const { tags } = await computeNextContactTags({
          user_id,
          phone: lead.phone,
          full_name: lead.name,
          military_branch: lead.military_branch,
        });
        const beneficiary_name = S(lead.beneficiary_name) || S(lead.beneficiary) || "";
        contactId = await upsertContactByUserPhone({
          user_id,
          phone: lead.phone,
          full_name: lead.name,
          tags,
          meta: { beneficiary: beneficiary_name, lead_id: insertedId },
        });
      }
    } catch (err) {
      console.error("[inbound] contact sync failed:", err);
    }

    // Provider idempotency key: honor Zapier's idempotency_key if present
    const providerMessageKey = S(p.idempotency_key) || null;

    // Send welcome/new lead text (server-side only; client won't double-send)
    let sendRes = null;
    try {
      sendRes = await trySendNewLeadText({
        userId: user_id,
        leadId: insertedId,
        contactId,
        lead,
        providerMessageKey,
      });
    } catch (err) {
      console.error("[inbound] send new lead failed:", err);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, id: insertedId, send: sendRes }),
    };
  } catch (e) {
    console.error("[inbound] unhandled:", e);
    return { statusCode: 500, body: "Server error" };
  }
};
