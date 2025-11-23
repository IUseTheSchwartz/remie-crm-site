// File: netlify/functions/goat-leads-webhook.js
// Webhook for Goat Leads → creates a lead row, then triggers messages-send
// URL pattern (for now): /.netlify/functions/goat-leads-webhook?uid=<user_id>

const { getServiceClient } = require("./_supabase");
const fetch = require("node-fetch");

function json(obj, statusCode = 200) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  };
}

const onlyDigits = (s) => String(s || "").replace(/\D/g, "");
const norm10 = (p) => {
  const d = onlyDigits(p);
  if (!d) return null;
  if (d.length === 11 && d.startsWith("1")) return d.slice(1);
  if (d.length >= 10) return d.slice(-10);
  return null;
};
const toE164 = (p) => {
  const n = norm10(p);
  return n ? `+1${n}` : null;
};

function parseBody(raw) {
  if (!raw) return {};
  // Try JSON first
  try {
    return JSON.parse(raw);
  } catch (_) {}
  // Fallback: form-encoded
  try {
    return Object.fromEntries(new URLSearchParams(raw));
  } catch (_) {}
  return {};
}

exports.handler = async (event) => {
  // Goat (or their infra) may send HEAD/GET pings just to verify the URL
  if (event.httpMethod === "HEAD") {
    return { statusCode: 200, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return json({ ok: true, message: "Goat leads webhook live" });
  }

  const db = getServiceClient();
  const qs = event.queryStringParameters || {};
  const user_id = qs.uid || null;

  if (!user_id) {
    return json(
      {
        error: "missing_uid",
        hint: "Add ?uid=<user_id> to the webhook URL you give Goat Leads.",
      },
      400
    );
  }

  const data = parseBody(event.body || "");
  const get = (k) => (Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null);

  // Map Goat fields → leads columns
  const firstName = get("First Name") || "";
  const lastName = get("Last Name") || "";
  const fullName =
    (get("Name") || `${firstName} ${lastName}` || "").trim() || null;

  const phoneRaw = get("Phone");
  const phoneE164 = toE164(phoneRaw);
  const email = get("Email") || null;
  const state = get("State") || null;
  const dob = get("DOB") || null;
  const age = get("Age") || null;
  const gender = get("Gender") || null;
  const beneficiary = get("Beneficiary") || null;
  const beneficiary_name = get("Beneficiary Name") || null;
  const military_status = get("Military Status") || null;

  const leadType = get("Lead Type") || null;          // "Veteran Lead"
  const leadSubType = get("Lead Sub-Type") || null;   // "Premium"
  const agedBucket = get("Aged Bucket") || null;      // "FRESH"
  const vendorId = get("ID") || null;
  const trustedFormUrl = get("Trusted Form URL") || null;
  const ipAddress = get("IP Address") || null;

  const leadRow = {
    user_id,
    name: fullName,
    phone: phoneE164 || phoneRaw || null,
    email,
    state,
    dob,
    age,
    gender,
    beneficiary,
    beneficiary_name,
    military_branch: military_status,
    lead_type: leadType,
    lead_subtype: leadSubType,
    aged_bucket: agedBucket,
    external_id: vendorId ? String(vendorId) : null,
    source: "goat_leads",
    trusted_form_url: trustedFormUrl,
    ip_address: ipAddress,
    raw_vendor: data,       // JSONB column is ideal; if you don't have it, you can drop this
    stage: "no_pickup",
    status: "open",
  };

  // Strip null/undefined so we don't hit missing columns
  for (const k of Object.keys(leadRow)) {
    if (leadRow[k] == null) delete leadRow[k];
  }

  let inserted;
  try {
    const { data: ins, error } = await db
      .from("leads")
      .insert([leadRow])
      .select("id")
      .single();
    if (error) {
      console.error("[goat-leads] insert error:", error);
      return json(
        { error: "db_insert_failed", detail: error.message || String(error) },
        500
      );
    }
    inserted = ins;
  } catch (e) {
    console.error("[goat-leads] unhandled insert error:", e);
    return json({ error: "db_insert_failed", detail: String(e) }, 500);
  }

  const lead_id = inserted?.id;

  // Fire-and-forget: trigger your existing messages-send function
  // It will respect templates + auto_new_lead_texts_enabled toggle.
  try {
    const base =
      process.env.SELF_BASE_URL ||
      process.env.URL ||
      process.env.DEPLOY_PRIME_URL ||
      "https://remiecrm.com";

    await fetch(`${base.replace(/\/+$/, "")}/.netlify/functions/messages-send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Remie-Billing": "free_first",
      },
      body: JSON.stringify({
        lead_id,
        requesterId: user_id,
        // no templateKey → messages-send will choose new_lead vs new_lead_military
      }),
    });
  } catch (e) {
    console.error("[goat-leads] messages-send failed (non-fatal):", e);
    // we still return 200 to Goat so they don't retry forever
  }

  return json({ ok: true, lead_id });
};
