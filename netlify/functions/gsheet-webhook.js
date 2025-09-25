// netlify/functions/gsheet-webhook.js
const crypto = require("crypto");
const fetch = require("node-fetch"); // ensure fetch exists
const { getServiceClient } = require("./_supabase");

// Create service client (uses SUPABASE_URL + SUPABASE_SERVICE_ROLE or SUPABASE_SERVICE_ROLE_KEY)
const supabase = getServiceClient();

// --- config: tag → template mapping ---
const TAG_TEMPLATE_MAP = {
  military: "new_lead_military",
  // add more here if you like:
  // spanish: "new_lead_es",
  // preneed: "new_lead_preneed",
};

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

// 💳 balance lookup (user_wallets.balance_cents)
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
    console.error("[getBalanceCents] lookup failed:", e.message || e);
  }
  return 0;
}

// --- templates → send helper (wallet-gated; skip if recently sent; schema-aligned logging) ---
function renderTemplate(tpl, ctx) {
  return String(tpl || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, k) => S(ctx[k]));
}

// ✨ soften content to reduce carrier filtering
function softenContent(text) {
  if (!text) return text;
  let out = String(text);

  // Replace bare 10-digit sequences with a formatted +1 version (carriers dislike bare 10s)
  out = out.replace(/\b(\d{3})(\d{3})(\d{4})\b/g, "+1 $1-$2-$3");

  // Ensure opt-out hint (helps trust)
  if (!/stop to opt out/i.test(out)) {
    out = out.trim() + " Reply STOP to opt out.";
  }

  // Keep first message reasonably short
  if (out.length > 500) out = out.slice(0, 500);

  return out;
}

// Decide template key from tags / lead info
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
      const tags = Array.isArray(c?.tags) ? c.tags.map(t => String(t).toLowerCase()) : [];
      for (const t of tags) {
        const mapped = TAG_TEMPLATE_MAP[normalizeTag(t)];
        if (mapped) return mapped;
      }
    }
  } catch {}
  return key;
}

// --- Telnyx helpers ---
async function telnyxSendSMS({ to, text }) {
  const body = { to, text };
  const profile = getMessagingProfileId();
  const from = getFromNumber();
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

// Poll once for latest Telnyx status (no webhook required)
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

/**
 * 1) Pre-check wallet (no negative)
 * 2) Skip sending if we've already sent to this number in the last 10 min
 * 3) Insert first (debit trigger), then send; mark 'sent' or 'error'
 *    + strong idempotency via provider_message_id = `lead:{leadId}:tpl:{template_key}`
 */
async function trySendNewLeadText({ userId, leadId, contactId, lead }) {
  // 1) Phone
  if (!S(lead.phone)) return { ok: false, reason: "missing_phone" };
  const to = toE164(lead.phone);
  if (!to) return { ok: false, reason: "invalid_phone", detail: lead.phone };

  // 2) Telnyx env
  const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
  const TELNYX_MESSAGING_PROFILE_ID = getMessagingProfileId();
  const FROM_NUMBER_ANY = getFromNumber();
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

  // 3) Determine template key from tags / lead
  const template_key = await chooseTemplateKey({ userId, contactId, lead });

  // 4) Load template + agent profile
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

  // 4.5) 💳 Pre-check wallet
  const COST_CENTS = 1;
  const balance = await getBalanceCents(userId);
  if (balance < COST_CENTS) {
    return { ok: false, reason: "insufficient_balance", balance_cents: balance };
  }

  // 4.6) ⛔ Double-send guard (10 min)
  if (await alreadySentRecently(userId, to, 10)) {
    return { ok: true, skipped: true, reason: "already_sent_recently" };
  }

  // Build + soften text body
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

  // Strong idempotency key includes template
  const dedupeKey = `lead:${leadId || "n/a"}:tpl:${template_key}`;

  // Pre-check for a prior send with this dedupe key
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
  } catch {}

  // PHASE 1: Insert "queued"
  const preRow = {
    user_id: userId,
    contact_id: contactId || null,
    lead_id: leadId || null,
    provider: "telnyx",
    direction: "outgoing",
    from_number: getFromNumber() || null,
    to_number: to,
    body: text,
    status: "queued",
    segments: 1,
    price_cents: 1, // keep in sync with wallet debit trigger
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

  // ---------------- PHASE 2: Send via Telnyx ----------------
  try {
    const send = await telnyxSendSMS({ to, text });
    console.log("[gsheet-webhook] Telnyx response", {
      ok: send.ok,
      status: send.status,
      id: send.json?.data?.id || null,
      errors: send.json?.errors || null,
      to,
      from: getFromNumber() || "(profile)",
      provider_message_id: dedupeKey,
    });

    if (!send.ok) {
      await supabase
        .from("messages")
        .update({ status: "error", error_detail: JSON.stringify(send.json).slice(0, 1000) })
        .eq("id", messageId);
      return { ok: false, reason: "telnyx_error", telnyx: send.json, message_id: messageId };
    }

    const providerId = send.json?.data?.id || null;

    // Mark sent initially (accepted by Telnyx)
    await supabase
      .from("messages")
      .update({ status: providerId ? "sent" : "error", provider_sid: providerId })
      .eq("id", messageId);

    // -------- PHASE 2.5: Poll once for latest status (no webhooks needed) --------
    if (providerId) {
      try {
        const getRes = await telnyxGetMessage(providerId);
        const payload = getRes.json?.data || {};

        console.log("[gsheet-webhook] Telnyx GET payload (trunc)", {
          http_status: getRes.status,
          has_data: !!getRes.json?.data,
          keys: payload ? Object.keys(payload).slice(0, 12) : [],
          raw_snippet: JSON.stringify(payload).slice(0, 400)
        });

        let statusRaw =
          payload?.to?.[0]?.status ||
          payload?.delivery_status ||
          payload?.status || "";

        // >>> NEW: dump carrier errors (if any)
        const carrierErrs1 = payload?.to?.[0]?.errors || payload?.errors || null;
        console.log("[gsheet-webhook] Telnyx carrier errors (trunc)",
          JSON.stringify(carrierErrs1 || {}).slice(0, 400)
        );

        // Try a second quick poll if empty
        if (!statusRaw) {
          await new Promise(r => setTimeout(r, 1500));
          const getRes2 = await telnyxGetMessage(providerId);
          const payload2 = getRes2.json?.data || {};
          console.log("[gsheet-webhook] Telnyx GET payload #2 (trunc)", {
            http_status: getRes2.status,
            has_data: !!getRes2.json?.data,
            keys: payload2 ? Object.keys(payload2).slice(0, 12) : [],
            raw_snippet: JSON.stringify(payload2).slice(0, 400)
          });
          statusRaw =
            payload2?.to?.[0]?.status ||
            payload2?.delivery_status ||
            payload2?.status || "";

          // >>> NEW: dump carrier errors from second poll too
          const carrierErrs2 = payload2?.to?.[0]?.errors || payload2?.errors || null;
          console.log("[gsheet-webhook] Telnyx carrier errors #2 (trunc)",
            JSON.stringify(carrierErrs2 || {}).slice(0, 400)
          );
        }

        const mapped = mapTelnyxStatus(statusRaw);
        const detail = {
          polled: true,
          http_status: getRes.status,
          provider_sid: providerId,
          statusRaw: statusRaw || "(empty)",
          errors: (payload?.to?.[0]?.errors || payload?.errors || null),
        };

        // If carrier already says failed/rejected/undeliverable, flip to error now.
        const updates = { error_detail: JSON.stringify(detail).slice(0, 1000) };
        if (mapped === "error") updates.status = "error";
        if (mapped === "delivered") updates.status = "delivered";

        await supabase.from("messages").update(updates).eq("id", messageId);

        console.log("[gsheet-webhook] Telnyx polled", { provider_sid: providerId, mapped, statusRaw: statusRaw || "(empty)" });
      } catch (pollErr) {
        console.error("[gsheet-webhook] Telnyx poll failed:", pollErr?.message || pollErr);
      }
    }

    return { ok: true, telnyx_ok: true, provider_message_id: dedupeKey, provider_sid: providerId, message_id: messageId };
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
      // military_branch comes straight from payload if present
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

        // <<< IMPORTANT: Do NOT send on the dedupe path (avoid parallel multi-send)
        await supabase
          .from("user_inbound_webhooks")
          .update({ last_used_at: new Date().toISOString() })
          .eq("id", webhookId);

        console.log("[gsheet-webhook] dedupe path hit: skipping send to prevent duplicates");
        return {
          statusCode: 200,
          body: JSON.stringify({
            ok: true,
            id: dupId,
            deduped: true,
            skipped: true,
            reason: "duplicate_lead_no_send",
          }),
        };
      }
    }

    // Insert lead
    const { data, error: insErr } = await supabase.from("leads").insert([lead]).select("id");
    if (insErr) {
      console.error("Insert error:", insErr);

      // Gracefully handle unique violation (no send)
      if (insErr.code === "23505") {
        return {
          statusCode: 200,
          body: JSON.stringify({ ok: true, skipped: true, reason: "duplicate_lead_insert" }),
        };
      }

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

    // Send (wallet-gated + double-send guard + strong idempotency + tag-aware template)
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
