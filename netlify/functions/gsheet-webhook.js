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
  try { return String(v).trim(); } catch { return ""; }
}

// Return undefined if blank (so we omit the column entirely)
function U(v) {
  const s = S(v);
  return s === "" ? undefined : s;
}

// Try to normalize a date-like string to YYYY-MM-DD; return undefined if invalid
function toYMD(v) {
  const s = S(v);
  if (!s) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s; // already ISO date
  const m = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})$/);
  if (m) {
    let mm = parseInt(m[1], 10), dd = parseInt(m[2], 10), yy = String(m[3]);
    if (yy.length === 2) yy = (yy >= "50" ? "19" : "20") + yy; // naive century
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
      const ymd = `${yy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
      const d = new Date(ymd + "T00:00:00Z");
      if (!Number.isNaN(d.getTime())) return ymd;
    }
  }
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
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
    const lead = {
      user_id: wh.user_id,
      name:  U(p.name) ?? null,
      phone: U(p.phone) ?? null,
      email: U(p.email) ?? null,
      state: U(p.state) ?? null,
      created_at: U(p.created_at) || new Date().toISOString(),
    };

    const extras = {
      notes:            U(p.notes),
      beneficiary:      U(p.beneficiary),
      beneficiary_name: U(p.beneficiary_name),
      company:          U(p.company),
      gender:           U(p.gender),
    };
    const dobYMD = toYMD(p.dob);
    if (dobYMD) extras.dob = dobYMD;
    for (const [k, v] of Object.entries(extras)) {
      if (v !== undefined) lead[k] = v;
    }

    // Require at least one identifier
    if (!lead.name && !lead.phone && !lead.email) {
      return { statusCode: 400, body: "Empty lead payload" };
    }

    // ---------- DEDUPE GUARD (10-minute window) ----------
    // If email or phone present, check recent inserts to avoid duplicates
    const orFilters = [];
    if (lead.email) orFilters.push(`email.eq.${encodeURIComponent(lead.email)}`);
    if (lead.phone) orFilters.push(`phone.eq.${encodeURIComponent(lead.phone)}`);

    if (orFilters.length) {
      const cutoffISO = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 minutes ago
      const { data: existing, error: qErr } = await supabase
        .from("leads")
        .select("id, created_at")
        .eq("user_id", wh.user_id)
        .gte("created_at", cutoffISO)
        .or(orFilters.join(","))
        .limit(1);

      if (!qErr && existing && existing.length) {
        // treat as success; return existing id
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
      // surface DB error to help diagnose quickly
      return { statusCode: 500, body: JSON.stringify({ ok: false, error: insErr }) };
    }

    // Update last_used_at for the webhook (non-blocking)
    await supabase
      .from("user_inbound_webhooks")
      .update({ last_used_at: new Date().toISOString() })
      .eq("id", webhookId);

    return { statusCode: 200, body: JSON.stringify({ ok: true, id: data?.[0]?.id }) };
  } catch (e) {
    console.error(e);
    return { statusCode: 500, body: "Server error" };
  }
};
