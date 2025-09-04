// netlify/functions/gsheet-webhook.js
const crypto = require("crypto");

let supabase;
try {
  supabase = require("./_supabase").supabase;
} catch {
  const { createClient } = require("@supabase/supabase-js");
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE);
}

function timingSafeEqual(a, b) {
  const A = Buffer.from(a || "", "utf8");
  const B = Buffer.from(b || "", "utf8");
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

function S(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (v instanceof Date) return v.toISOString();
  try { return String(v).trim(); } catch { return ""; }
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

    const webhookId =
      (event.queryStringParameters && event.queryStringParameters.id) ||
      event.headers["x-webhook-id"] ||
      event.headers["X-Webhook-Id"];
    if (!webhookId) return { statusCode: 400, body: "Missing webhook id" };

    const { data: rows, error } = await supabase
      .from("user_inbound_webhooks")
      .select("id, user_id, secret, active")
      .eq("id", webhookId)
      .limit(1);

    if (error || !rows?.length) return { statusCode: 404, body: "Webhook not found" };
    const wh = rows[0];
    if (!wh.active) return { statusCode: 403, body: "Webhook disabled" };

    const providedSig = event.headers["x-signature"] || event.headers["X-Signature"];
    if (!providedSig) return { statusCode: 401, body: "Missing signature" };

    const rawBody = getRawBody(event);
    const computed = crypto.createHmac("sha256", wh.secret).update(rawBody, "utf8").digest("base64");
    if (!timingSafeEqual(computed, providedSig)) return { statusCode: 401, body: "Invalid signature" };

    let p;
    try { p = JSON.parse(rawBody); }
    catch { return { statusCode: 400, body: "Invalid JSON" }; }

    const lead = {
      owner_user_id: wh.user_id,
      name:  S(p.name),
      phone: S(p.phone),
      email: S(p.email),
      state: S(p.state),
      notes: S(p.notes),
      status: "lead",  // drop this too if your table doesn't have it
      created_at: p.created_at ? S(p.created_at) : new Date().toISOString(),
    };

    if (!lead.name && !lead.phone && !lead.email) {
      return { statusCode: 400, body: "Empty lead payload" };
    }

    const { data, error: insErr } = await supabase
      .from("leads")
      .insert([lead])
      .select("id");

    if (insErr) {
      console.error("Insert error:", insErr);
      return { statusCode: 500, body: "DB insert failed" };
    }

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
