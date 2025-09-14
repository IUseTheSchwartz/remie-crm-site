// netlify/functions/gsheet-webhook.js
const crypto = require("crypto");
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
  try {
    return String(v).trim();
  } catch {
    return "";
  }
}

// Return undefined if blank (so we omit the column entirely)
function U(v) {
  const s = S(v);
  return s === "" ? undefined : s;
}

// 🔁 Normalize any date-like input to MM/DD/YYYY (string). Return undefined if invalid.
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

function getRawBody(event) {
  let raw = event.body || "";
  if (event.isBase64Encoded) {
    try {
      raw = Buffer.from(raw, "base64").toString("utf8");
    } catch {}
  }
  return raw;
}

// --- contact tag + dedupe helpers ---
function normalizeTag(s) {
  return String(s ?? "").trim().toLowerCase().replace(/\s+/g, "_");
}
function uniqTags(arr) {
  return Array.from(new Set((arr || []).map(normalizeTag))).filter(Boolean);
}
function normalizePhone(s) {
  const d = String(s || "").replace(/\D/g, "");
  return d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
}

/**
 * ✅ FIXED: Status tags are now **exclusive**.
 * If military_branch is present → ["military"]; else → ["lead"].
 * (We also preserve any non-status tags.)
 */
async function computeNextContactTags({ supabase, user_id, phone, full_name, military_branch }) {
  const phoneNorm = normalizePhone(phone);

  const { data: candidates, error } = await supabase
    .from("message_contacts")
    .select("id, phone, tags")
    .eq("user_id", user_id);

  if (error) throw error;

  const existing = (candidates || []).find((c) => normalizePhone(c.phone) === phoneNorm);
  const current = Array.isArray(existing?.tags) ? existing.tags : [];

  const withoutStatus = current.filter(
    (t) => !["lead", "military"].includes(normalizeTag(t))
  );

  const status = (S(military_branch) ? "military" : "lead");
  const next = uniqTags([...withoutStatus, status]);

  return { contactId: existing?.id ?? null, tags: next };
}

/**
 * Upsert contact and MERGE meta so we can store `beneficiary` + `lead_id` safely.
 */
async function upsertContactByUserPhone(
  supabase,
  { user_id, phone, full_name, tags, meta = {} }
) {
  const phoneNorm = normalizePhone(phone);

  const { data: candidates, error } = await supabase
    .from("message_contacts")
    .select("id, phone, full_name, tags, meta")
    .eq("user_id", user_id);

  if (error) throw error;

  const existing = (candidates || []).find((c) => normalizePhone(c.phone) === phoneNorm);

  if (existing?.id) {
    const mergedMeta = { ...(existing.meta || {}), ...(meta || {}) };
    const { error: uErr } = await supabase
      .from("message_contacts")
      .update({
        full_name: full_name || existing.full_name || null,
        tags,
        meta: mergedMeta,
      })
      .eq("id", existing.id);
    if (uErr) throw uErr;
    return existing.id;
  } else {
    const { data: ins, error: iErr } = await supabase
      .from("message_contacts")
      .insert([
        {
          user_id,
          phone,
          full_name: full_name || null,
          tags,
          meta,
        },
      ])
      .select("id")
      .single();
    if (iErr) throw iErr;
    return ins.id;
  }
}

// --- templates → send helper (centralized via messages-send) ---
function renderTemplate(tpl, ctx) {
  return String(tpl || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, k) => S(ctx[k]));
}

async function trySendNewLeadText({ userId, leadId, lead }) {
  // We do NOT render the body here anymore.
  // We defer to lead-new-auto → messages-send so the send is templated, logged, debited, and traced consistently.

  if (!S(lead.phone)) return { sent: false, reason: "missing_phone" };

  const base = process.env.SITE_URL || process.env.URL;
  if (!base) return { sent: false, reason: "no_site_url" };

  try {
    const res = await fetch(`${base}/.netlify/functions/lead-new-auto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lead_id: leadId }),
    });
    const out = await res.json().catch(() => ({}));

    if (!res.ok || out?.error || !out?.send?.ok) {
      return { sent: false, reason: "send_failed", detail: out };
    }
    return {
      sent: true,
      telnyx_id: out?.send?.provider_sid || out?.send?.provider_message_id || null,
      trace: out?.send?.trace || out?.trace || null,
    };
  } catch (e) {
    return { sent: false, reason: "lead_new_auto_unreachable", detail: e?.message };
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
    const computed = crypto
      .createHmac("sha256", wh.secret)
      .update(rawBody, "utf8")
      .digest("base64");
    if (!timingSafeEqual(computed, providedSig)) return { statusCode: 401, body: "Invalid signature" };

    let p;
    try {
      p = JSON.parse(rawBody);
    } catch {
      return { statusCode: 400, body: "Invalid JSON" };
    }

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
      company: U(p.company),
      gender: U(p.gender),
      military_branch: U(p.military_branch),
    };

    const dobMDY = toMDY(p.dob);
    if (dobMDY) extras.dob = dobMDY;

    for (const [k, v] of Object.entries(extras)) {
      if (v !== undefined) lead[k] = v;
    }

    if (!lead.name && !lead.phone && !lead.email) {
      return { statusCode: 400, body: "Empty lead payload" };
    }

    // ---------- DEDUPE GUARD ----------
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
        // Even if deduped, we still want to update contact tags/meta and (optionally) send.
        const dupId = existing[0].id;

        // tags/meta sync
        try {
          if (lead.phone) {
            const { tags } = await computeNextContactTags({
              supabase,
              user_id: wh.user_id,
              phone: lead.phone,
              full_name: lead.name,
              military_branch: lead.military_branch,
            });

            const beneficiary = lead.beneficiary || lead.beneficiary_name || "";

            await upsertContactByUserPhone(supabase, {
              user_id: wh.user_id,
              phone: lead.phone,
              full_name: lead.name,
              tags,
              meta: { beneficiary, lead_id: dupId },
            });
          }
        } catch (err) {
          console.error("contact tag/meta sync (dedup) failed:", err);
        }

        // try send (centralized via messages-send)
        try {
          await trySendNewLeadText({
            userId: wh.user_id,
            leadId: dupId,
            lead: {
              name: lead.name,
              phone: lead.phone,
              state: lead.state,
              beneficiary: lead.beneficiary,
              beneficiary_name: lead.beneficiary_name,
              military_branch: lead.military_branch,
            },
          });
        } catch (e) {
          console.error("send (dedup) failed:", e);
        }

        return {
          statusCode: 200,
          body: JSON.stringify({ ok: true, id: dupId, deduped: true }),
        };
      }
    }

    const { data, error: insErr } = await supabase.from("leads").insert([lead]).select("id");
    if (insErr) {
      console.error("Insert error:", insErr);
      return { statusCode: 500, body: JSON.stringify({ ok: false, error: insErr }) };
    }

    const insertedId = data?.[0]?.id || null;

    // 🔔 Send welcome/new-lead message via centralized sender so it lands in public.messages
    try {
      await trySendNewLeadText({
        userId: wh.user_id,
        leadId: insertedId,
        lead: {
          name: lead.name,
          phone: lead.phone,
          state: lead.state,
          beneficiary: lead.beneficiary,
          beneficiary_name: lead.beneficiary_name,
          military_branch: lead.military_branch,
        },
      });
    } catch (err) {
      console.error("send new lead failed:", err);
    }

    // ✅ sync tags + meta (beneficiary + lead_id) into message_contacts (exclusive status tag)
    try {
      if (lead.phone) {
        const { tags } = await computeNextContactTags({
          supabase,
          user_id: wh.user_id,
          phone: lead.phone,
          full_name: lead.name,
          military_branch: lead.military_branch,
        });
        const beneficiary = lead.beneficiary || lead.beneficiary_name || "";
        await upsertContactByUserPhone(supabase, {
          user_id: wh.user_id,
          phone: lead.phone,
          full_name: lead.name,
          tags,
          meta: {
            beneficiary,
            lead_id: insertedId,
          },
        });
      }
    } catch (err) {
      console.error("contact tag/meta sync failed:", err);
    }

    const { data: verifyRow, error: verifyErr } = await supabase
      .from("leads")
      .select("id, created_at")
      .eq("id", insertedId)
      .maybeSingle();

    const projectRef =
      (process.env.SUPABASE_URL || "").match(/https?:\/\/([^.]+)\.supabase\.co/i)?.[1] ||
      "unknown";

    await supabase
      .from("user_inbound_webhooks")
      .update({ last_used_at: new Date().toISOString() })
      .eq("id", webhookId);

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        id: insertedId,
        verify_found: !!verifyRow && !verifyErr,
        project_ref: projectRef,
      }),
    };
  } catch (e) {
    console.error(e);
    return { statusCode: 500, body: "Server error" };
  }
};
