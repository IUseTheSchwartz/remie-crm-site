// netlify/functions/gsheet-webhook.js
const crypto = require("crypto");
const { getServiceClient } = require("./_supabase");
const { sendNewLeadIfEnabled } = require("./lib/messaging.js"); // ✅ added

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

// Return undefined if blank (so we omit the column entirely)
function U(v) {
  const s = S(v);
  return s === "" ? undefined : s;
}

// 🔁 Normalize any date-like input to MM/DD/YYYY (string). Return undefined if invalid.
function toMDY(v) {
  if (v == null) return undefined;

  // Direct Date object
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    const mm = String(v.getMonth() + 1).padStart(2, "0");
    const dd = String(v.getDate()).padStart(2, "0");
    const yy = v.getFullYear();
    return `${mm}/${dd}/${yy}`;
  }

  const s = String(v).trim();
  if (!s) return undefined;

  // If already YYYY-MM-DD → convert to MM/DD/YYYY
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const [, y, m, d] = iso;
    return `${m}/${d}/${y}`;
  }

  // Common US formats: M/D/YYYY or M/D/YY (also -, . separators)
  const us = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (us) {
    let mm = parseInt(us[1], 10);
    let dd = parseInt(us[2], 10);
    let yy = us[3];
    if (yy.length === 2) yy = (yy >= "50" ? "19" : "20") + yy; // naive century
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
      return `${String(mm).padStart(2, "0")}/${String(dd).padStart(2, "0")}/${yy}`;
    }
  }

  // Fallback: Date.parse() for verbose strings like "Sun May 04 1952 ..."
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
    try { raw = Buffer.from(raw, "base64").toString("utf8"); } catch {}
  }
  return raw;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "Method Not Allowed" };
    }

    // Webhook id from query or header
    const webhookId =
      (event.queryStringParameters && event.queryStringParameters.id) ||
      event.headers["x-webhook-id"] ||
      event.headers["X-Webhook-Id"];
    if (!webhookId) return { statusCode: 400, body: "Missing webhook id" };

    // Look up per-user secret + user id
    const { data: rows, error: hookErr } = await supabase
      .from("user_inbound_webhooks")
      .select("id, user_id, secret, active")
      .eq("id", webhookId)
      .limit(1);

    if (hookErr || !rows?.length) return { statusCode: 404, body: "Webhook not found" };
    const wh = rows[0];
    if (!wh.active) return { statusCode: 403, body: "Webhook disabled" };

    // Verify HMAC
    const providedSig = event.headers["x-signature"] || event.headers["X-Signature"];
    if (!providedSig) return { statusCode: 401, body: "Missing signature" };

    const rawBody = getRawBody(event);
    const computed = crypto.createHmac("sha256", wh.secret).update(rawBody, "utf8").digest("base64");
    if (!timingSafeEqual(computed, providedSig)) return { statusCode: 401, body: "Invalid signature" };

    // Parse payload
    let p;
    try { p = JSON.parse(rawBody); }
    catch { return { statusCode: 400, body: "Invalid JSON" }; }

    // Build record (omit blank extras)
    const nowIso = new Date().toISOString();
    const lead = {
      user_id: wh.user_id,
      name:  U(p.name) ?? null,
      phone: U(p.phone) ?? null,
      email: U(p.email) ?? null,
      state: U(p.state) ?? null,
      created_at: U(p.created_at) || nowIso,

      // ✅ pipeline-safe defaults
      stage: "no_pickup",
      stage_changed_at: nowIso,
      priority: "medium",
      call_attempts: 0,
      last_outcome: "",
      pipeline: {},
    };

    const extras = {
      notes:            U(p.notes),
      beneficiary:      U(p.beneficiary),
      beneficiary_name: U(p.beneficiary_name),
      company:          U(p.company),
      gender:           U(p.gender),
      military_branch:  U(p.military_branch),
    };

    const dobMDY = toMDY(p.dob);
    if (dobMDY) extras.dob = dobMDY;

    for (const [k, v] of Object.entries(extras)) {
      if (v !== undefined) lead[k] = v;
    }

    if (!lead.name && !lead.phone && !lead.email) {
      return { statusCode: 400, body: "Empty lead payload" };
    }

    // ---------- DEDUPE GUARD (10-minute window) ----------
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
        return { statusCode: 200, body: JSON.stringify({ ok: true, id: existing[0].id, deduped: true }) };
      }
    }
    // ------------------------------------------------------

    const { data, error: insErr } = await supabase
      .from("leads")
      .insert([lead])
      .select("id");

    if (insErr) {
      console.error("Insert error:", insErr);
      return { statusCode: 500, body: JSON.stringify({ ok: false, error: insErr }) };
    }

    const insertedId = data?.[0]?.id || null;

    // ✅ NEW: Auto-message for brand new leads (respects per-user toggles)
    try {
      await sendNewLeadIfEnabled({
        userId: wh.user_id,
        leadId: insertedId,
        lead: {
          name: lead.name,
          phone: lead.phone,
          state: lead.state,
          beneficiary: lead.beneficiary,
          military_branch: lead.military_branch,
        },
      });
    } catch (err) {
      console.error("sendNewLeadIfEnabled failed:", err);
    }

    // Verify immediately
    const { data: verifyRow, error: verifyErr } = await supabase
      .from("leads")
      .select("id, created_at")
      .eq("id", insertedId)
      .maybeSingle();

    const projectRef = (process.env.SUPABASE_URL || "").match(/https?:\/\/([^.]+)\.supabase\.co/i)?.[1] || "unknown";

    // Update last_used_at for the webhook (non-blocking)
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
