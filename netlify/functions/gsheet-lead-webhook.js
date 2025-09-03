// netlify/functions/gsheet-lead-webhook.js
import { createClient } from "@supabase/supabase-js";

/**
 * ENV you must set in Netlify:
 * - SUPABASE_URL
 * - SUPABASE_SERVICE_ROLE   (service role key for server-side writes)
 * - GSHEET_WEBHOOK_SECRET   (quick-start shared secret; optional if you use per-user secrets)
 *
 * Optional schema (for per-user secrets):
 *   Table: lead_sources
 *   Columns:
 *     user_id        uuid/text (PK/FK to your users table)
 *     secret         text      (unique)
 *     source_type    text      default 'google_sheet'
 *     is_active      boolean   default true
 */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE
);

export default async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { error: "Method Not Allowed" });
    }

    // 1) Auth: get secret & uid
    const headerSecret =
      event.headers["x-webhook-secret"] || event.headers["X-Webhook-Secret"];
    const envSecret = process.env.GSHEET_WEBHOOK_SECRET || "";
    const uid = (event.queryStringParameters?.uid || "").trim(); // optional

    if (!headerSecret) {
      return json(401, { error: "Missing X-Webhook-Secret header" });
    }

    // If you pass ?uid=, try to validate against per-user secret in DB
    if (uid) {
      const { data: src, error } = await supabase
        .from("lead_sources")
        .select("secret,is_active")
        .eq("user_id", uid)
        .eq("source_type", "google_sheet")
        .single();

      if (error || !src) return json(403, { error: "Unknown user or source" });
      if (!src.is_active) return json(403, { error: "Source disabled" });
      if (src.secret !== headerSecret)
        return json(403, { error: "Invalid secret for user" });
    } else {
      // No uid → fall back to shared env secret
      if (!envSecret || headerSecret !== envSecret) {
        return json(403, { error: "Invalid shared secret" });
      }
    }

    // 2) Parse body (one row or array of rows)
    let payload = {};
    try {
      payload = JSON.parse(event.body || "{}");
    } catch (e) {
      return json(400, { error: "Invalid JSON body" });
    }
    const rows = Array.isArray(payload) ? payload : [payload];

    // 3) Normalize fields per row
    const now = new Date().toISOString();
    const toInsert = rows
      .map((r0) => {
        const r = r0 || {};
        // flexible field names from sheet
        const name =
          r.name || r.Name || r.fullName || r.FullName || r.Full_Name || "";
        const phone = r.phone || r.Phone || r.number || r.Number || "";
        const email = (r.email || r.Email || "").toLowerCase();
        const notes = r.notes || r.Notes || "";
        const dob = r.dob || r.DOB || r.birthdate || r["date of birth"] || "";
        const state = (r.state || r.State || "").toString().toUpperCase();
        const beneficiary = r.beneficiary || r.Beneficiary || "";
        const beneficiary_name =
          r.beneficiary_name || r["beneficiary name"] || r.BeneficiaryName || "";
        const gender = r.gender || r.Gender || "";

        // decide user_id
        const user_id = uid || r.userId || r.user_id || null;

        // Require at least one of name/phone/email
        if (!(name || phone || email)) return null;

        return {
          user_id,                // nullable if you don't use multi-tenant yet
          name,
          phone,
          email,
          notes,
          status: "lead",
          dob,
          state,
          beneficiary,
          beneficiary_name,
          company: r.company || r.Company || "",
          gender,
          raw: r,                 // JSONB column recommended
          created_at: now,
        };
      })
      .filter(Boolean);

    if (!toInsert.length) {
      return json(400, { error: "No usable rows" });
    }

    // 4) Insert
    const { error: insertErr } = await supabase.from("leads").insert(toInsert);
    if (insertErr) {
      return json(500, { error: "DB insert failed", details: insertErr.message });
    }

    return json(200, { ok: true, inserted: toInsert.length });
  } catch (e) {
    return json(500, { error: "Unhandled", details: e.message });
  }
};

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  };
}
