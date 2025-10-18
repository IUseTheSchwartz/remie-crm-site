// netlify/functions/zap-webhook.js
// Ingest leads from Zapier (or any HTTP client) using Basic Auth:
//   username = webhook id (wh_u_...)
//   password = webhook secret
//
// Does ALL the work:
//  - Auth
//  - Insert lead (with recent-dup guard)
//  - Upsert contact (exclusive tag: 'military' or 'lead')
//  - Auto-send new lead template (military-aware) via messages-send
//  - Push notify the user on new lead

const crypto = require("crypto");
const fetch = require("node-fetch"); // ensure fetch exists in function runtime
const { getServiceClient } = require("./_supabase");
const { sendPushToUser } = require("../lib/_push"); // push helper

const supabase = getServiceClient();

function json(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  };
}

const S = (v) => (v == null ? "" : typeof v === "string" ? v.trim() : String(v).trim());
const U = (v) => {
  const s = S(v);
  return s === "" ? undefined : s;
};

// ---- phone helpers (keep in sync with other fns) ----
const onlyDigits = (s) => String(s || "").replace(/\D/g, "");
const normalizePhone = (s) => {
  const d = onlyDigits(s);
  return d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
};
const toE164 = (p) => {
  const d = onlyDigits(p);
  if (!d) return null;
  if (d.startsWith("1") && d.length === 11) return `+${d}`;
  if (d.length === 10) return `+1${d}`;
  if (String(p || "").startsWith("+")) return String(p);
  return null;
};

// Exclusive contact status tag
const normalizeTag = (s) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, "_");
const uniqTags = (arr) => Array.from(new Set((arr || []).map(normalizeTag))).filter(Boolean);

// ---- tiny date normalizer for dob (optional) ----
function toMDY(v) {
  if (!v) return undefined;
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    const mm = String(v.getMonth() + 1).padStart(2, "0");
    const dd = String(v.getDate()).padStart(2, "0");
    const yy = v.getFullYear();
    return `${mm}/${dd}/${yy}`;
  }
  const s = S(v);
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
    const dd = String(d.getDate()).padStart(2, "0"); // ← fixed
    const yy = d.getFullYear();
    return `${mm}/${dd}/${yy}`;
  }
  return undefined;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { error: "method_not_allowed" });
    }

    /* ============ BASIC AUTH ============ */
    const auth = event.headers.authorization || event.headers.Authorization || "";
    if (!auth.startsWith("Basic ")) {
      return json(401, { error: "missing_basic_auth" });
    }
    let userpass;
    try {
      userpass = Buffer.from(auth.slice(6).trim(), "base64").toString("utf8"); // "id:secret"
    } catch {
      return json(401, { error: "bad_basic_header" });
    }
    const sep = userpass.indexOf(":");
    if (sep === -1) return json(401, { error: "malformed_basic_pair" });

    const webhookId = userpass.slice(0, sep).trim();
    const providedSecret = userpass.slice(sep + 1).trim();

    if (!webhookId || !providedSecret) return json(401, { error: "empty_basic_fields" });

    const { data: rows, error: hookErr } = await supabase
      .from("user_inbound_webhooks")
      .select("id, user_id, secret, active")
      .eq("id", webhookId)
      .limit(1);

    if (hookErr) return json(500, { error: "db_error", detail: hookErr.message });
    if (!rows || !rows.length) return json(403, { error: "unknown_webhook_id" });

    const hook = rows[0];
    if (!hook.active) return json(403, { error: "webhook_disabled" });

    const secretOk =
      Buffer.byteLength(hook.secret) === Buffer.byteLength(providedSecret) &&
      crypto.timingSafeEqual(Buffer.from(hook.secret), Buffer.from(providedSecret));
    if (!secretOk) return json(403, { error: "bad_credentials" });

    /* =========================
     * Body parse & normalization
     * ========================= */
    let p = {};
    try {
      p = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { error: "invalid_json" });
    }

    // Use your established keys (matches Sheets/Zap mapping)
    const lead = {
      user_id: hook.user_id,
      name: U(p.name) ?? null,
      phone: U(p.phone) ?? null,
      email: (U(p.email) || "")?.toLowerCase() || null,
      state: U(p.state) ?? null,
      notes: U(p.notes) ?? null,
      beneficiary: U(p.beneficiary) ?? null,
      beneficiary_name: U(p.beneficiary_name) ?? null,
      gender: U(p.gender) ?? null,
      company: U(p.company) ?? null,
      military_branch: U(p.military_branch) ?? null,
      // optional dob normalization
      dob: toMDY(p.dob) || null,

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

    /* =========================
     * 10-minute de-dupe guard
     * (phone/email for this user)
     * ========================= */
    const orFilters = [];
    if (lead.email) orFilters.push(`email.eq.${encodeURIComponent(lead.email)}`);
    if (lead.phone) orFilters.push(`phone.eq.${encodeURIComponent(lead.phone)}`);

    if (orFilters.length) {
      const cutoffISO = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const { data: existing, error: qErr } = await supabase
        .from("leads")
        .select("id, created_at")
        .eq("user_id", hook.user_id)
        .gte("created_at", cutoffISO)
        .or(orFilters.join(","))
        .limit(1);

      if (!qErr && existing && existing.length) {
        const dupId = existing[0].id;

        // still update last_used_at for visibility
        await supabase
          .from("user_inbound_webhooks")
          .update({ last_used_at: new Date().toISOString() })
          .eq("id", webhookId);

        return json(200, {
          ok: true,
          id: dupId,
          deduped: true,
          skipped: true,
          reason: "duplicate_lead_no_send",
        });
      }
    }

    /* ==========
     * Insert lead
     * ========== */
    const { data: ins, error: insErr } = await supabase
      .from("leads")
      .insert([lead])
      .select("id")
      .single();

    if (insErr) {
      const msg = (insErr.message || "").toLowerCase();
      if (msg.includes("duplicate") || insErr.code === "23505") {
        return json(200, { ok: true, skipped: true, reason: "duplicate_lead_insert" });
      }
      return json(500, { error: "insert_failed", detail: insErr.message });
    }
    const insertedId = ins?.id;

    // Touch last_used_at for visibility
    await supabase
      .from("user_inbound_webhooks")
      .update({ last_used_at: new Date().toISOString() })
      .eq("id", webhookId);

    /* ---- Push notify the agent ---- */
    try {
      const who = S(lead.name) || S(lead.email) || S(lead.phone) || "New lead";
      const parts = [];
      if (S(lead.phone)) parts.push(S(lead.phone));
      if (S(lead.state)) parts.push(S(lead.state));
      const bodyText = parts.join(" • ");
      await sendPushToUser(hook.user_id, {
        title: `New lead: ${who}`,
        body: bodyText || "Tap to view",
        url: "/app",
        tag: `lead-${insertedId}`,
        renotify: false,
      });
    } catch (e) {
      console.warn("[zap-webhook] push notify warn:", e?.message || e);
    }

    /* =========================
     * Upsert Contact + status tag
     * ========================= */
    try {
      if (lead.phone) {
        const e164 = toE164(lead.phone);
        if (e164) {
          const phoneDigits = onlyDigits(e164);
          const { data: existingRows, error: selErr } = await supabase
            .from("message_contacts")
            .select("id, phone, tags")
            .eq("user_id", hook.user_id)
            .order("created_at", { ascending: false });
          if (selErr) throw selErr;

          const existing =
            (existingRows || []).find((r) => onlyDigits(r.phone) === phoneDigits) || null;

          const statusTag = S(lead.military_branch) ? "military" : "lead";
          const base = {
            user_id: hook.user_id,
            phone: e164, // store canonical
            full_name: lead.name || null,
            subscribed: true,
            meta: { lead_id: insertedId },
          };

          if (existing?.id) {
            const cur = Array.isArray(existing.tags) ? existing.tags : [];
            const withoutStatus = cur.filter(
              (t) => !["lead", "military"].includes(String(t).toLowerCase())
            );
            const nextTags = uniqTags([...withoutStatus, statusTag]);
            await supabase.from("message_contacts").update({ ...base, tags: nextTags }).eq("id", existing.id);
          } else {
            await supabase.from("message_contacts").insert([{ ...base, tags: [statusTag] }]);
          }
        }
      }
    } catch (e) {
      console.warn("[zap-webhook] contact upsert warning:", e?.message || e);
      // non-fatal
    }

    /* =========================
     * Auto-send initial template
     * ========================= */
    try {
      const templateKey = S(lead.military_branch) ? "new_lead_military" : "new_lead";
      const provider_message_id = `lead:${insertedId}:tpl:${templateKey}`; // strong dedupe

      // Build base URL (works on Netlify)
      const proto = event.headers["x-forwarded-proto"] || "https";
      const host =
        event.headers.host ||
        (process.env.URL || process.env.SITE_URL || "").replace(/^https?:\/\//, "");
      const base = process.env.SITE_URL || (proto && host ? `${proto}://${host}` : null);
      if (base) {
        const res = await fetch(`${base}/.netlify/functions/messages-send`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            lead_id: insertedId,
            templateKey, // messages-send accepts templateKey | template_key | template
            provider_message_id,
          }),
        });
        // best-effort; response is informative but non-blocking
        const out = await res.json().catch(() => ({}));
        console.log("[zap-webhook] messages-send:", res.status, out?.ok ? "ok" : out);
      }
    } catch (e) {
      console.warn("[zap-webhook] auto-send warning:", e?.message || e);
    }

    return json(200, { ok: true, id: insertedId });
  } catch (e) {
    console.error("[zap-webhook] unhandled:", e);
    return json(500, { error: "server_error" });
  }
};