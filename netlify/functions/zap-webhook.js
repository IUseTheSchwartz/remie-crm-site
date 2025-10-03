// netlify/functions/zap-webhook.js
// Ingest leads from Zapier (or any HTTP client) using Basic Auth:
//   username = webhook id (wh_u_...)
//   password = webhook secret
//
// Returns 200 on success, 401/403/4xx on failures with clear messages.

const { getServiceClient } = require("./_supabase");

const supabase = getServiceClient();

function json(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  };
}

function S(v) {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return String(v);
  return String(v || "").trim();
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { error: "method_not_allowed" });
    }

    /* =========================
     *  AUTH (Basic) — 403 path
     * ========================= */
    const auth = event.headers.authorization || event.headers.Authorization || "";
    if (!auth.startsWith("Basic ")) {
      // No Basic header at all → 401
      return json(401, { error: "missing_basic_auth" });
    }

    // Decode the Basic token → "username:password"
    // (Zapier UI `username|password` becomes header `Basic base64(username:password)` automatically.)
    let userpass;
    try {
      const b64 = auth.slice(6).trim();
      userpass = Buffer.from(b64, "base64").toString("utf8"); // "wh_u_xxx:secret"
    } catch {
      return json(401, { error: "bad_basic_header" });
    }

    const sep = userpass.indexOf(":");
    if (sep === -1) {
      // If the decoded value didn’t contain ":", header is malformed
      return json(401, { error: "malformed_basic_pair" });
    }

    const webhookId = userpass.slice(0, sep).trim();   // username
    const providedSecret = userpass.slice(sep + 1).trim(); // password

    if (!webhookId || !providedSecret) {
      return json(401, { error: "empty_basic_fields" });
    }

    // Look up the webhook row by ID
    const { data: rows, error: hookErr } = await supabase
      .from("user_inbound_webhooks")
      .select("id, user_id, secret, active")
      .eq("id", webhookId)
      .limit(1);

    if (hookErr) {
      // DB error → fail closed
      return json(500, { error: "db_error", detail: hookErr.message });
    }
    if (!rows || !rows.length) {
      // Unknown webhook id → 403 Forbidden
      return json(403, { error: "unknown_webhook_id" });
    }

    const hook = rows[0];

    if (!hook.active) {
      // Disabled webhook → 403
      return json(403, { error: "webhook_disabled" });
    }

    // Constant-time compare of the secret → 403 if mismatch
    const ok =
      Buffer.byteLength(hook.secret) === Buffer.byteLength(providedSecret) &&
      crypto.timingSafeEqual(Buffer.from(hook.secret), Buffer.from(providedSecret));

    if (!ok) {
      return json(403, { error: "bad_credentials" });
    }

    /* =========================
     *  Body parse & normalization
     * ========================= */
    let p = {};
    try {
      p = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { error: "invalid_json" });
    }

    // Build lead record (aligns with your gsheet-webhook fields)
    const lead = {
      user_id: hook.user_id,
      name: S(p.name) || null,
      phone: S(p.phone) || null,
      email: S(p.email).toLowerCase() || null,
      state: S(p.state) || null,
      notes: S(p.notes) || null,
      beneficiary: S(p.beneficiary) || null,
      beneficiary_name: S(p.beneficiary_name) || null,
      gender: S(p.gender) || null,
      company: S(p.company) || null,
      military_branch: S(p.military_branch) || null,

      // pipeline defaults
      stage: "no_pickup",
      stage_changed_at: new Date().toISOString(),
      priority: "medium",
      call_attempts: 0,
      last_outcome: "",
      pipeline: {},
      created_at: new Date().toISOString(),
    };

    if (!lead.name && !lead.phone && !lead.email) {
      return json(400, { error: "empty_payload" });
    }

    // Insert lead
    const { data: ins, error: insErr } = await supabase
      .from("leads")
      .insert([lead])
      .select("id")
      .single();

    if (insErr) {
      // Graceful duplicate handling
      const msg = (insErr.message || "").toLowerCase();
      if (msg.includes("duplicate") || insErr.code === "23505") {
        return json(200, { ok: true, skipped: true, reason: "duplicate_lead_insert" });
      }
      return json(500, { error: "insert_failed", detail: insErr.message });
    }

    // Touch last_used_at for visibility
    await supabase
      .from("user_inbound_webhooks")
      .update({ last_used_at: new Date().toISOString() })
      .eq("id", webhookId);

    return json(200, { ok: true, id: ins.id });
  } catch (e) {
    console.error("[zap-webhook] unhandled:", e);
    return json(500, { error: "server_error" });
  }
};

const crypto = require("crypto");
