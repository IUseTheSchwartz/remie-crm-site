// netlify/functions/gsheet-webhook.js
const crypto = require("crypto");
const fetch = require("node-fetch"); // <-- ensure fetch exists in runtime
const { getServiceClient } = require("./_supabase");

// Create service client (uses SUPABASE_URL + SUPABASE_SERVICE_ROLE or SUPABASE_SERVICE_ROLE_KEY)
const supabase = getServiceClient();

function timingSafeEqual(a, b) {
  const A = Buffer.from(a || "", "utf8");
  const B = Buffer.from(b || "", "utf8");
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

// Coerce to trimmed string; empty -> ""
function S(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (v instanceof Date) return v.toISOString();
  try { return String(v).trim(); } catch { return ""; }
}
function U(v) { const s = S(v); return s === "" ? undefined : s; }

// 🔁 Normalize any date-like input to MM/DD/YYYY (string). Return undefined if invalid.
function toMDY(v) {
  if (v == null) return undefined;
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    const mm = String(v.getMonth() + 1).padStart(2, "0");
    const dd = String(v.getDate()).padStart(2, "0");
    const yy = v.getFullYear();
    return `${mm}/${dd}/${yy}`;
  }
  const s = String(v).trim(); if (!s) return undefined;
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/); if (iso) { const [, y, m, d] = iso; return `${m}/${d}/${y}`; }
  const us = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (us) {
    let mm = parseInt(us[1], 10); let dd = parseInt(us[2], 10); let yy = us[3];
    if (yy.length === 2) yy = (yy >= "50" ? "19" : "20") + yy;
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
      return `${String(mm).padStart(2,"0")}/${String(dd).padStart(2,"0")}/${yy}`;
    }
  }
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) {
    const mm = String(d.getMonth()+1).padStart(2,"0");
    const dd = String(d.getDate()).padStart(2,"0");
    const yy = d.getFullYear();
    return `${mm}/${dd}/${yy}`;
  }
  return undefined;
}

function getRawBody(event) {
  let raw = event.body || "";
  if (event.isBase64Encoded) {
    try { raw = Buffer.from(raw, "base64").toString("utf8"); } catch {}
  }
  return raw;
}

// --- phone helpers ---
function normalizeTag(s){return String(s??"").trim().toLowerCase().replace(/\s+/g,"_")}
function uniqTags(arr){return Array.from(new Set((arr||[]).map(normalizeTag))).filter(Boolean)}
function onlyDigits(s){return String(s||"").replace(/\D/g,"")}
function normalizePhone(s){const d=onlyDigits(s); return d.length===11&&d.startsWith("1")?d.slice(1):d;}
function toE164(s){const d=onlyDigits(s); if(!d) return null; if(d.length===11&&d.startsWith("1")) return `+${d}`; if(d.length===10) return `+1${d}`; return s&&s.startsWith("+")?s:null;}
function phoneVariants(raw){
  const d = onlyDigits(raw);
  const e = toE164(raw);
  const variants = new Set([raw, d, e].filter(Boolean));
  if (d.length===11 && d.startsWith("1")) variants.add(d.slice(1));
  if (d.length===10) { variants.add("1"+d); variants.add("+1"+d); }
  return Array.from(variants);
}

// --- ENV fallbacks for Telnyx routing ---
function getFromNumber() {
  return (
    process.env.TELNYX_FROM_NUMBER ||
    process.env.DEFAULT_FROM_NUMBER ||
    process.env.TELNYX_FROM ||
    null
  );
}
function getMessagingProfileId() {
  return process.env.TELNYX_MESSAGING_PROFILE_ID || null;
}

// --- contact tag + helpers ---
async function computeNextContactTags({ supabase, user_id, phone, full_name, military_branch }) {
  const phoneNorm = normalizePhone(phone);
  const { data: candidates, error } = await supabase
    .from("message_contacts")
    .select("id, phone, tags")
    .eq("user_id", user_id);
  if (error) throw error;

  const existing = (candidates || []).find((c) => normalizePhone(c.phone) === phoneNorm);
  const current = Array.isArray(existing?.tags) ? existing.tags : [];
  const withoutStatus = current.filter((t) => !["lead", "military"].includes(normalizeTag(t)));
  const status = (S(military_branch) ? "military" : "lead");
  const next = uniqTags([...withoutStatus, status]);
  return { contactId: existing?.id ?? null, tags: next };
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

async function upsertContactByUserPhone(supabase, { user_id, phone, full_name, tags, meta = {} }) {
  const cleanTags = Array.isArray(tags) ? tags.filter(Boolean).map(String) : [];
  const phoneE164 = toE164(phone) || phone; // canonical we store

  const existing = await findContactByPhone(user_id, phone);
  if (existing?.id) {
    const mergedMeta = { ...(existing.meta || {}), ...(meta || {}) };
    const { error: uErr } = await supabase
      .from("message_contacts")
      .update({
        phone: phoneE164,   // store canonical
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

// --- message de-dupe (skip double send within window) ---
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
  if (error) return false; // don't hard-fail; just allow
  return (data && data.length > 0);
}

// 💳 HARD-CODED balance lookup (text_wallets.balance_cents)
async function getBalanceCents(userId) {
  try {
    const { data, error } = await supabase
      .from("text_wallets")
      .select("balance_cents")
      .eq("user_id", userId)
      .single();
    if (error) throw error;
    const n = Number(data?.balance_cents ?? 0);
    if (!Number.isNaN(n)) return Math.floor(n);
  } catch {}
  return 0;
}

// --- templates → send helper (wallet-gated; skip if recently sent; schema-aligned logging) ---
function renderTemplate(tpl, ctx) {
  return String(tpl || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, k) => S(ctx[k]));
}

/**
 * 1) Pre-check wallet (no negative)
 * 2) Skip sending if we've already sent to this number in the last 10 min
 * 3) Insert first (debit trigger), then send; mark 'sent' or 'error'
 *    + strong idempotency via provider_message_id = `lead:{leadId}:tpl:new_lead`
 */
async function trySendNewLeadText({ userId, leadId, contactId, lead }) {
  // 1) Phone
  if (!S(lead.phone)) return { ok: false, reason: "missing_phone" };
  const to = toE164(lead.phone);
  if (!to) return { ok: false, reason: "invalid_phone", detail: lead.phone };

  // 2) Telnyx env (allow profile OR from number)
  const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
  const TELNYX_MESSAGING_PROFILE_ID = getMessagingProfileId();
  const FROM_NUMBER_ANY = getFromNumber();
  // Require API key, plus at least one routing path
  if (!TELNYX_API_KEY || (!TELNYX_MESSAGING_PROFILE_ID && !FROM_NUMBER_ANY)) {
    return {
      ok: false,
      reason: "telnyx_env_missing",
      detail: {
        have_api_key: !!TELNYX_API_KEY,
        have_profile: !!TELNYX_MESSAGING_PROFILE_ID,
        have_from_number: !!FROM_NUMBER_ANY,
      },
    };
  }

  // 3) Template + agent profile
  const { data: trow, error: terr } = await supabase
    .from("message_templates")
    .select("templates")
    .eq("user_id", userId)
    .single();
  if (terr) return { ok: false, reason: "template_load_error", detail: terr.message };

  const template_key = "new_lead"; // currently fixed; can map from tags later if needed
  const tpl = trow?.templates?.[template_key];
  if (!tpl) return { ok: false, reason: "template_not_found", template_key };

  const { data: agent, error: aerr } = await supabase
    .from("agent_profiles")
    .select("full_name, phone, calendly_url")
    .eq("user_id", userId)
    .single();
  if (aerr) return { ok: false, reason: "agent_profile_missing", detail: aerr.message };

  // 3.5) 💳 Pre-check wallet (soft guard; prevents negative)
  const COST_CENTS = 1;
  const balance = await getBalanceCents(userId);
  if (balance < COST_CENTS) {
    return { ok: false, reason: "insufficient_balance", balance_cents: balance };
  }

  // 3.6) ⛔ Double-send guard (10 min window)
  if (await alreadySentRecently(userId, to, 10)) {
    return { ok: true, skipped: true, reason: "already_sent_recently" };
  }

  // Prefer the beneficiary *name*; expose legacy + explicit keys
  const beneficiary_name = S(lead.beneficiary_name) || S(lead.beneficiary);
  const vars = {
    first_name: S(lead.name).split(" ")[0] || "",
    agent_name: agent?.full_name || "",
    agent_phone: agent?.phone || "",
    calendly_link: agent?.calendly_url || "",
    state: S(lead.state),
    beneficiary: beneficiary_name,
    beneficiary_name: beneficiary_name,
  };
  const text = renderTemplate(tpl, vars);

  // Strong idempotency key for this lead + template
  const dedupeKey = `lead:${leadId || "n/a"}:tpl:${template_key}`;

  // Pre-check for a prior send with this dedupe key (strong idempotency)
  try {
    const { data: dupe } = await supabase
      .from("messages")
      .select("id")
      .eq("user_id", userId)
      .eq("provider_message_id", dedupeKey)
      .limit(1);
    if (dupe && dupe.length) {
      return { ok: true, skipped: true, reason: "deduped_by_provider_message_id", provider_message_id: dedupeKey };
    }
  } catch (_) {}

  // PHASE 1: Insert first → AFTER INSERT debit trigger handles accounting
  const preRow = {
    user_id: userId,
    contact_id: contactId || null,
    lead_id: leadId || null,
    provider: "telnyx",
    direction: "outgoing",
    from_number: FROM_NUMBER_ANY || null,
    to_number: to,
    body: text,
    status: "queued",     // will flip to 'sent' after Telnyx ok
    segments: 1,
    price_cents: COST_CENTS,
    channel: "sms",
    provider_message_id: dedupeKey, // store our idempotent key up front
  };

  const { data: inserted, error: preErr } = await supabase
    .from("messages")
    .insert(preRow)
    .select("id")
    .single();

  if (preErr) {
    // If unique constraint exists on (user_id, provider_message_id), this covers the race
    if ((preErr.message || "").toLowerCase().includes("duplicate")) {
      return { ok: true, skipped: true, reason: "deduped_on_insert", provider_message_id: dedupeKey };
    }
    return { ok: false, reason: "preinsert_failed", detail: preErr.message };
  }
  const messageId = inserted.id;

  // PHASE 2: Send via Telnyx
  const clientRef = `c=${contactId || "n/a"}|lead=${leadId || "n/a"}|tpl=${template_key}|ts=${Date.now()}`;
  try {
    const telnyxBody = { to, text, client_ref: clientRef };
    if (getMessagingProfileId()) telnyxBody.messaging_profile_id = getMessagingProfileId();
    if (getFromNumber()) telnyxBody.from = getFromNumber();

    const resp = await fetch("https://api.telnyx.com/v2/messages", {
      method: "POST",
      headers: { Authorization: `Bearer ${TELNYX_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(telnyxBody),
    });
    const json = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      await supabase
        .from("messages")
        .update({ status: "error", error_detail: JSON.stringify(json).slice(0, 1000) })
        .eq("id", messageId);
      return { ok: false, reason: "telnyx_error", telnyx: json, message_id: messageId };
    }

    const providerId = json?.data?.id || null;

    // PHASE 3: Mark sent + keep our deterministic provider_message_id
    await supabase
      .from("messages")
      .update({ status: "sent", provider_sid: providerId })
      .eq("id", messageId);

    return { ok: true, provider_message_id: dedupeKey, message_id: messageId };
  } catch (e) {
    await supabase
      .from("messages")
      .update({ status: "error", error_detail: String(e?.message || e).slice(0, 1000) })
      .eq("id", messageId);
    return { ok: false, reason: "telnyx_request_failed", detail: e?.message, message_id: messageId };
  }
}

// --- main handler ---
exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "Method Not Allowed" };
    }

    const webhookId =
      (event.queryStringParameters && event.queryStringParameters.id) ||
      event.headers["x-webhook-id"] ||
      event.headers["X-Webhook-Id"];
    if (!webhookId) return { statusCode: 400, body: "Missing webhook id" };

    const { data: rows, error: hookErr } = await supabase
      .from("user_inbound_webhooks")
      .select("id, user_id, secret, active")
      .eq("id", webhookId)
      .limit(1);
    if (hookErr || !rows?.length) return { statusCode: 404, body: "Webhook not found" };
    const wh = rows[0];
    if (!wh.active) return { statusCode: 403, body: "Webhook disabled" };

    const providedSig = event.headers["x-signature"] || event.headers["X-Signature"];
    if (!providedSig) return { statusCode: 401, body: "Missing signature" };

    const rawBody = getRawBody(event);
    const computed = crypto.createHmac("sha256", wh.secret).update(rawBody, "utf8").digest("base64");
    if (!timingSafeEqual(computed, providedSig)) return { statusCode: 401, body: "Invalid signature" };

    let p; try { p = JSON.parse(rawBody); } catch { return { statusCode: 400, body: "Invalid JSON" }; }

    const nowIso = new Date().toISOString();
    const lead = {
      user_id: wh.user_id,
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
    };

    const extras = {
      notes: U(p.notes),
      beneficiary: U(p.beneficiary),
      beneficiary_name: U(p.beneficiary_name),
      beneficiary_relation: U(p.beneficiary_relation),
      company: U(p.company),
      gender: U(p.gender),
      military_branch: U(p.military_branch),
    };
    const dobMDY = toMDY(p.dob); if (dobMDY) extras.dob = dobMDY;
    for (const [k, v] of Object.entries(extras)) if (v !== undefined) lead[k] = v;

    if (!lead.name && !lead.phone && !lead.email) {
      return { statusCode: 400, body: "Empty lead payload" };
    }

    // ---------- DEDUPE GUARD (10 min, phone/email) ----------
    const orFilters = [];
    if (lead.email) orFilters.push(`email.eq.${encodeURIComponent(lead.email)}`);
    if (lead.phone) orFilters.push(`phone.eq.${encodeURIComponent(lead.phone)}`);

    if (orFilters.length) {
      const cutoffISO = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const { data: existing, error: qErr } = await supabase
        .from("leads")
        .select("id, created_at")
        .eq("user_id", wh.user_id)
        .gte("created_at", cutoffISO)
        .or(orFilters.join(","))
        .limit(1);

      if (!qErr && existing && existing.length) {
        const dupId = existing[0].id;

        // Upsert contact (for logging/threading) with canonical phone
        let contactId = null;
        try {
          if (lead.phone) {
            const { tags } = await computeNextContactTags({
              supabase,
              user_id: wh.user_id,
              phone: lead.phone,
              full_name: lead.name,
              military_branch: lead.military_branch,
            });
            const beneficiary_name = S(lead.beneficiary_name) || S(lead.beneficiary) || "";
            contactId = await upsertContactByUserPhone(supabase, {
              user_id: wh.user_id,
              phone: lead.phone,
              full_name: lead.name,
              tags,
              meta: { beneficiary: beneficiary_name, lead_id: dupId },
            });
          }
        } catch (err) { console.error("contact tag/meta sync (dedup) failed:", err); }

        // Send only if not sent recently (prevents duplicate text)
        let sendRes = null;
        try {
          sendRes = await trySendNewLeadText({
            userId: wh.user_id,
            leadId: dupId,
            contactId,
            lead,
          });
        } catch (e) { console.error("send (dedup) failed:", e); }

        await supabase
          .from("user_inbound_webhooks")
          .update({ last_used_at: new Date().toISOString() })
          .eq("id", webhookId);

        console.log("[gsheet-webhook] sendRes (dedupe path):", JSON.stringify(sendRes));
        return { statusCode: 200, body: JSON.stringify({ ok: true, id: dupId, deduped: true, send: sendRes }) };
      }
    }

    // Insert lead
    const { data, error: insErr } = await supabase.from("leads").insert([lead]).select("id");
    if (insErr) {
      console.error("Insert error:", insErr);
      return { statusCode: 500, body: JSON.stringify({ ok: false, error: insErr }) };
    }
    const insertedId = data?.[0]?.id || null;

    // Upsert contact BEFORE sending → capture contactId for logging/threading
    let contactId = null;
    try {
      if (lead.phone) {
        const { tags } = await computeNextContactTags({
          supabase,
          user_id: wh.user_id,
          phone: lead.phone,
          full_name: lead.name,
          military_branch: lead.military_branch,
        });
        const beneficiary_name = S(lead.beneficiary_name) || S(lead.beneficiary) || "";
        contactId = await upsertContactByUserPhone(supabase, {
          user_id: wh.user_id,
          phone: lead.phone,
          full_name: lead.name,
          tags,
          meta: { beneficiary: beneficiary_name, lead_id: insertedId },
        });
      }
    } catch (err) { console.error("contact tag/meta sync failed:", err); }

    // Send (wallet-gated + double-send guard + strong idempotency)
    let sendRes = null;
    try {
      sendRes = await trySendNewLeadText({
        userId: wh.user_id,
        leadId: insertedId,
        contactId,
        lead,
      });
    } catch (err) { console.error("send new lead failed:", err); }

    const { data: verifyRow, error: verifyErr } = await supabase
      .from("leads")
      .select("id, created_at")
      .eq("id", insertedId)
      .maybeSingle();

    const projectRef =
      (process.env.SUPABASE_URL || "").match(/https?:\/\/([^.]+)\.supabase\.co/i)?.[1] || "unknown";

    await supabase
      .from("user_inbound_webhooks")
      .update({ last_used_at: new Date().toISOString() })
      .eq("id", webhookId);

    console.log("[gsheet-webhook] sendRes:", JSON.stringify(sendRes));
    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        id: insertedId,
        verify_found: !!verifyRow && !verifyErr,
        project_ref: projectRef,
        send: sendRes,
      }),
    };
  } catch (e) {
    console.error(e);
    return { statusCode: 500, body: "Server error" };
  }
};
