// File: netlify/functions/goat-leads-inbound.js
// Accepts Goat Leads style JSON, finds user by ?token=,
// inserts into leads, tags contact, and fires messages-send (new_lead / new_lead_military).

const { getServiceClient } = require("./_supabase");
const fetch = require("node-fetch");

function json(body, statusCode = 200) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

const onlyDigits = (s) => String(s || "").replace(/\D/g, "");
const norm10 = (s) => onlyDigits(s).slice(-10);
function toE164(p) {
  const d = onlyDigits(p);
  if (!d) return null;
  if (d.startsWith("1") && d.length === 11) return `+${d}`;
  if (d.length === 10) return `+1${d}`;
  if (String(p || "").startsWith("+")) return String(p);
  return null;
}

function getFnBase() {
  const base =
    process.env.SITE_URL ||
    process.env.URL ||
    process.env.DEPLOY_PRIME_URL ||
    "https://remiecrm.com";
  return `${String(base).replace(/\/+$/, "")}/.netlify/functions`;
}

exports.handler = async (event) => {
  const db = getServiceClient();

  try {
    const token =
      (event.queryStringParameters &&
        event.queryStringParameters.token &&
        String(event.queryStringParameters.token)) ||
      null;

    if (!token) {
      return json({ ok: false, error: "missing_token" }, 400);
    }

    // Find which user this token belongs to
    const { data: ap, error: apErr } = await db
      .from("agent_profiles")
      .select("user_id")
      .eq("goat_webhook_token", token)
      .maybeSingle();
    if (apErr) throw apErr;
    if (!ap || !ap.user_id) {
      return json({ ok: false, error: "invalid_token" }, 404);
    }
    const user_id = ap.user_id;

    // Parse body (Goat sent you JSON like the sample you pasted)
    let payload = {};
    try {
      payload = JSON.parse(event.body || "{}");
    } catch (e) {
      console.error("[goat-leads-inbound] invalid JSON", e);
      return json({ ok: false, error: "invalid_json" }, 400);
    }

    // Extract fields from Goat payload
    const firstName =
      payload["First Name"] || payload.first_name || payload.firstname || "";
    const lastName =
      payload["Last Name"] || payload.last_name || payload.lastname || "";
    const phoneRaw = payload["Phone"] || payload.phone || "";
    const email = payload["Email"] || payload.email || "";
    const state = payload["State"] || payload.state || "";
    const dob = payload["DOB"] || payload.dob || null;
    const beneficiary =
      payload["Beneficiary"] || payload.beneficiary || null;
    const beneficiaryName =
      payload["Beneficiary Name"] ||
      payload.beneficiary_name ||
      payload.beneficiaryName ||
      null;
    const gender = payload["Gender"] || payload.gender || null;
    const militaryStatus =
      payload["Military Status"] || payload.military_status || "";
    const leadType = payload["Lead Type"] || payload.lead_type || null;
    const agedBucket = payload["Aged Bucket"] || payload.aged_bucket || null;
    const externalId = payload["ID"] || payload.id || null;

    const fullName = `${firstName || ""} ${lastName || ""}`.trim() || null;
    const phoneE164 = toE164(phoneRaw);

    if (!phoneE164) {
      console.error("[goat-leads-inbound] missing/invalid phone", phoneRaw);
      return json({ ok: false, error: "invalid_phone" }, 400);
    }

    const isMilitary =
      String(militaryStatus || "").toLowerCase().includes("veteran") ||
      String(leadType || "").toLowerCase().includes("veteran");

    // Insert into leads table
    const leadRow = {
      user_id,
      name: fullName,
      phone: phoneE164,
      email,
      dob,
      state,
      beneficiary: beneficiary || null,
      beneficiary_name: beneficiaryName || null,
      gender: gender || null,
      military_branch: militaryStatus || (isMilitary ? "Veteran" : null),
      status: "new",
      stage: "no_pickup",
      // optional extras if these columns exist; if not, harmless in Postgrest
      lead_type: leadType || null,
      aged_bucket: agedBucket || null,
      external_id: externalId || null,
      source: "goat_leads",
    };

    const insLead = await db
      .from("leads")
      .insert([leadRow])
      .select("id, phone, name");
    if (insLead.error) {
      console.error("[goat-leads-inbound] insert lead error", insLead.error);
      return json({ ok: false, error: "insert_lead_failed" }, 500);
    }
    const lead = insLead.data && insLead.data[0];
    const lead_id = lead.id;

    // Upsert contact with tags lead / military
    const last10 = norm10(phoneE164);
    const { data: contacts, error: cErr } = await db
      .from("message_contacts")
      .select("id, phone, tags")
      .eq("user_id", user_id);
    if (cErr) throw cErr;

    let contactId = null;
    const existing =
      (contacts || []).find((c) => norm10(c.phone) === last10) || null;

    const tagToUse = isMilitary ? "military" : "lead";

    if (existing) {
      const currentTags = Array.isArray(existing.tags)
        ? existing.tags.map(String)
        : [];
      const nextTags = [tagToUse];
      // keep other non-status tags
      for (const t of currentTags) {
        const lt = String(t || "").toLowerCase();
        if (["lead", "military", "sold"].includes(lt)) continue;
        if (!nextTags.includes(t)) nextTags.push(t);
      }

      const upd = await db
        .from("message_contacts")
        .update({
          phone: phoneE164,
          full_name: fullName,
          tags: nextTags,
        })
        .eq("id", existing.id)
        .select("id");
      if (upd.error) throw upd.error;
      contactId = upd.data[0].id;
    } else {
      const ins = await db
        .from("message_contacts")
        .insert([
          {
            user_id,
            phone: phoneE164,
            full_name: fullName,
            tags: [tagToUse],
            subscribed: true,
          },
        ])
        .select("id");
      if (ins.error) throw ins.error;
      contactId = ins.data[0].id;
    }

    // Fire new-lead auto-text via messages-send
    try {
      const fnBase = getFnBase();
      const templateKey = isMilitary ? "new_lead_military" : "new_lead";

      const res = await fetch(`${fnBase}/messages-send`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Remie-Billing": "free_first",
        },
        body: JSON.stringify({
          requesterId: user_id,
          lead_id,
          templateKey,
          billing: "free_first",
          preferFreeSegments: true,
        }),
      });

      const out = await res.json().catch(() => ({}));
      console.log("[goat-leads-inbound] messages-send result:", {
        status: res.status,
        out,
      });
    } catch (e) {
      console.error("[goat-leads-inbound] messages-send failed:", e);
      // but don’t fail the webhook; lead is already in CRM
    }

    return json({
      ok: true,
      lead_id,
      contact_id: contactId,
    });
  } catch (e) {
    console.error("[goat-leads-inbound] unhandled error:", e);
    return json({ ok: false, error: e.message || String(e) }, 500);
  }
};
