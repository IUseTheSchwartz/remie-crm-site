// netlify/functions/inbound.js
// Purpose: Zapier → RemieCRM ingest for new leads (Sheets or other sources)
// Auth:
//   - Required header:  X-Remie-Token: <ZAPIER_INBOUND_TOKEN>
//   - User context:     Provide user via body.requesterId (preferred) or header `x-user-id`
// Behavior:
//   - Normalize payload → upsert into `leads`
//   - Upsert/merge `message_contacts` with exclusive status tag (lead|military)
//   - Send "new lead" SMS (wallet-gated, TFN-verified, idempotent)
//   - Strong duplicate guards (recent-10m + provider_message_id)

const crypto = require("crypto");
const fetch = require("node-fetch");
const { getServiceClient } = require("./_supabase");

// Service client (service role)
const supabase = getServiceClient();

function json(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

// ---------- Small utils ----------
const S = (v) => (v == null ? "" : String(v).trim());
const U = (v) => {
  const s = S(v);
  return s === "" ? undefined : s;
};

// date → MM/DD/YYYY (string) or undefined
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
    if (String(yy).length === 2) yy = (yy >= "50" ? "19" : "20") + yy;
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
function toE164(phone) {
  const d = onlyDigits(phone);
  if (!d) return null;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  if (d.length === 10) return `+1${d}`;
  return String(phone || "").startsWith("+") ? String(phone) : null;
}
const normalizeTag = (s) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, "_");
const uniqTags = (arr) => Array.from(new Set((arr || []).map(normalizeTag))).filter(Boolean);

function normalizePhoneForMatch(s) {
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

// ---------- Contacts helpers ----------
async function findContactByPhone(user_id, phone) {
  const vars = phoneVariants(phone);
  if (!vars.length) return null;
  const { data, error } = await supabase
    .from("message_contacts")
    .select("id, phone, full_name, tags, meta")
    .eq("user_id", user_id)
    .in("phone", vars)
    .limit(1);
  if (error) throw error;
  return data?.[0] || null;
}

async function upsertContactByUserPhone({ user_id, phone, full_name, military_branch, meta = {} }) {
  if (!phone) return null;
  const existing = await findContactByPhone(user_id, phone);
  const statusTag = S(military_branch) ? "military" : "lead";
  const nextTags = uniqTags([...(existing?.tags || []).filter((t) => !["lead", "military"].includes(normalizeTag(t))), statusTag]);
  const phoneE164 = toE164(phone) || phone;

  if (existing?.id) {
    const mergedMeta = { ...(existing.meta || {}), ...(meta || {}) };
    const { error } = await supabase
      .from("message_contacts")
      .update({ phone: phoneE164, full_name: full_name || existing.full_name || null, tags: nextTags, meta: mergedMeta })
      .eq("id", existing.id);
    if (error) throw error;
    return existing.id;
  } else {
    const { data, error } = await supabase
      .from("message_contacts")
      .insert([{ user_id, phone: phoneE164, full_name: full_name || null, tags: nextTags, subscribed: true, meta }])
      .select("id")
      .single();
    if (error) throw error;
    return data.id;
  }
}

// ---------- Telnyx + wallet ----------
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
  if (!process.env.TELNYX_API_KEY) throw new Error("TELNYX_API_KEY missing");
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
  return !!(data && data.length);
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
    console.error("[inbound] balance lookup failed:", e?.message || e);
  }
  return 0;
}

function renderTemplate(tpl, ctx) {
  return String(tpl || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, k) => S(ctx[k]));
}

function softenContent(text) {
  if (!text) return text;
  let out = String(text);
  out = out.replace(/\b(\d{3})(\d{3})(\d{4})\b/g, "+1 $1-$2-$3"); // reduce carrier flags
  if (!/stop to opt out/i.test(out)) out = out.trim() + " Reply STOP to opt out.";
  if (out.length > 500) out = out.slice(0, 500);
  return out;
}

async function chooseTemplateKey({ userId, contactId, lead }) {
  let key = "new_lead";
  if (S(lead.military_branch)) return "new_lead_military";
  try {
    if (contactId) {
      const { data: c } = await supabase
        .from("message_contacts")
        .select("tags")
        .eq("id", contactId)
        .single();
      const tags = Array.isArray(c?.tags) ? c.tags.map((t) => String(t).toLowerCase()) : [];
      if (tags.includes("military")) return "new_lead_military";
    }
  } catch {}
  return key;
}

async function trySendNewLeadText({ userId, leadId, contactId, lead }) {
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
  if (balance < COST_CENTS) {
    return { ok: false, reason: "insufficient_balance", balance_cents: balance };
  }

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

  const dedupeKey = `lead:${leadId || "n/a"}:tpl:${template_key}`;

  // Check provider_message_id dupes
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

  // PHASE 1: insert queued
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
    price_cents: 1,
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

  // PHASE 2: send
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

    // one quick poll to improve status
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
        const updates = {};
        if (mapped === "error") updates.status = "error";
        if (mapped === "delivered") updates.status = "delivered";
        if (Object.keys(updates).length) {
          await supabase.from("messages").update(updates).eq("id", messageId);
        }
      } catch {}
    }

    return { ok: true, telnyx_ok: true, provider_message_id: dedupeKey, provider_sid: providerId, message_id: messageId };
  } catch (e) {
    await supabase.from("messages").update({ status: "error", error_detail: String(e?.message || e).slice(0, 1000) }).eq("id", messageId);
    return { ok: false, reason: "telnyx_request_failed", detail: e?.message, message_id: messageId };
  }
}

// ---------- Lead dedupe helpers ----------
function normEmail(s) {
  return String(s || "").trim().toLowerCase();
}

async function findRecentDuplicateLead({ user_id, email, phone, minutes = 10 }) {
  const orParts = [];
  if (email) orParts.push(`email.eq.${encodeURIComponent(email)}`);
  if (phone) orParts.push(`phone.eq.${encodeURIComponent(phone)}`);
  if (!orParts.length) return null;

  const cutoffISO = new Date(Date.now() - minutes * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("leads")
    .select("id, created_at")
    .eq("user_id", user_id)
    .gte("created_at", cutoffISO)
    .or(orParts.join(","))
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  return data?.[0]?.id || null;
}

// ---------- Handler ----------
exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { error: "method_not_allowed" });
    }

    // Auth: simple shared token
    const tokenHeader =
      event.headers["x-remie-token"] ||
      event.headers["X-Remie-Token"] ||
      event.headers["x-Remie-Token"];
    if (!tokenHeader) return json(401, { error: "missing_auth_token" });
    if (tokenHeader !== process.env.ZAPIER_INBOUND_TOKEN) {
      return json(401, { error: "invalid_auth_token" });
    }

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { error: "invalid_json" });
    }

    // User resolution
    const user_id =
      S(body.requesterId) ||
      S(event.headers["x-user-id"] || event.headers["X-User-Id"]) ||
      "";

    if (!user_id) {
      return json(400, { error: "missing_user_id", hint: "Provide body.requesterId or X-User-Id header" });
    }

    // Normalize incoming record (Zap mapping should pass these fields)
    const nowIso = new Date().toISOString();
    const lead = {
      user_id,
      name: U(body.name) ?? null,
      phone: U(body.phone) ?? null,
      email: U(normEmail(body.email)) ?? null,
      state: U(body.state) ?? null,
      notes: U(body.notes) ?? null,
      beneficiary: U(body.beneficiary) ?? null,
      beneficiary_name: U(body.beneficiary_name) ?? null,
      beneficiary_relation: U(body.beneficiary_relation) ?? null,
      company: U(body.company) ?? null,
      gender: U(body.gender) ?? null,
      military_branch: U(body.military_branch) ?? null,
      dob: toMDY(body.dob) ?? null,
      // pipeline defaults
      stage: "no_pickup",
      stage_changed_at: nowIso,
      priority: "medium",
      call_attempts: 0,
      last_outcome: "",
      pipeline: {},
      created_at: nowIso,
    };

    if (!lead.name && !lead.phone && !lead.email) {
      return json(400, { error: "empty_lead_payload" });
    }

    // Duplicate guard (recent window)
    const dupeId = await findRecentDuplicateLead({
      user_id,
      email: lead.email,
      phone: lead.phone,
      minutes: 10,
    });
    if (dupeId) {
      // ensure contact is updated even on dedupe
      try {
        if (lead.phone) {
          const beneficiary_name = S(lead.beneficiary_name) || S(lead.beneficiary) || "";
          await upsertContactByUserPhone({
            user_id,
            phone: lead.phone,
            full_name: lead.name,
            military_branch: lead.military_branch,
            meta: { beneficiary: beneficiary_name, lead_id: dupeId },
          });
        }
      } catch (e) {
        console.warn("[inbound] contact sync on dupe failed:", e?.message || e);
      }
      return json(200, { ok: true, id: dupeId, deduped: true, reason: "duplicate_lead_no_send" });
    }

    // Insert lead
    const { data: ins, error: insErr } = await supabase.from("leads").insert([lead]).select("id").single();
    if (insErr) {
      if (insErr.code === "23505" || /duplicate key/i.test(insErr.message || "")) {
        return json(200, { ok: true, skipped: true, reason: "duplicate_lead_insert" });
      }
      console.error("[inbound] insert error:", insErr);
      return json(500, { ok: false, error: "insert_failed", detail: insErr.message });
    }
    const leadId = ins?.id || null;

    // Upsert contact
    let contactId = null;
    try {
      if (lead.phone) {
        const beneficiary_name = S(lead.beneficiary_name) || S(lead.beneficiary) || "";
        contactId = await upsertContactByUserPhone({
          user_id,
          phone: lead.phone,
          full_name: lead.name,
          military_branch: lead.military_branch,
          meta: { beneficiary: beneficiary_name, lead_id: leadId },
        });
      }
    } catch (e) {
      console.warn("[inbound] contact upsert failed:", e?.message || e);
    }

    // Send welcome/new-lead text
    let sendRes = null;
    try {
      sendRes = await trySendNewLeadText({ userId: user_id, leadId, contactId, lead });
    } catch (e) {
      console.warn("[inbound] send failed:", e?.message || e);
    }

    return json(200, {
      ok: true,
      id: leadId,
      send: sendRes,
    });
  } catch (e) {
    console.error("[inbound] unhandled:", e);
    return json(500, { error: "server_error" });
  }
};
