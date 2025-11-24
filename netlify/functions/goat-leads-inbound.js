// netlify/functions/goat-leads-inbound.js
// Accepts Goat Leads (or test JSON) and inserts into `leads` for the user
// whose token matches ?token=... in the URL. Also can trigger auto-text
// via messages-send (new_lead / new_lead_military) if templates + toggle
// are enabled, and upserts a message_contact for the lead.

const { getServiceClient } = require("./_supabase");
const fetch = require("node-fetch");

const db = getServiceClient();

/* ---------------- helpers ---------------- */

function json(body, statusCode = 200) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

const onlyDigits = (s) => String(s || "").replace(/\D/g, "");

function toE164(p) {
  const d = onlyDigits(p);
  if (!d) return null;
  if (d.startsWith("1") && d.length === 11) return `+${d}`;
  if (d.length === 10) return `+1${d}`;
  if (String(p || "").startsWith("+")) return String(p);
  return null;
}

// returns the first non-empty trimmed string or null
function firstNonEmpty(...vals) {
  for (const v of vals) {
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (s !== "") return s;
  }
  return null;
}

// alias used in mapping
function safeString(...vals) {
  const v = firstNonEmpty(...vals);
  return v == null ? null : v;
}

const normalizeTag = (s) =>
  String(s ?? "").trim().toLowerCase().replace(/\s+/g, "_");
const uniqTags = (arr) =>
  Array.from(new Set((arr || []).map(normalizeTag))).filter(Boolean);

/* ---------------- contact upsert helper ---------------- */

async function upsertContactForLead({ user_id, phone, name, military_branch, lead_id }) {
  try {
    const e164 = toE164(phone);
    if (!e164) return;

    const digits = onlyDigits(e164);
    const { data, error } = await db
      .from("message_contacts")
      .select("id, phone, tags")
      .eq("user_id", user_id);

    if (error) throw error;

    const existing =
      (data || []).find((c) => onlyDigits(c.phone) === digits) || null;

    const statusTag = military_branch ? "military" : "lead";
    const base = {
      user_id,
      phone: e164,
      full_name: name || null,
      subscribed: true,
      meta: { lead_id },
    };

    if (existing?.id) {
      const cur = Array.isArray(existing.tags) ? existing.tags : [];
      const without = cur.filter(
        (t) => !["lead", "military"].includes(String(t).toLowerCase())
      );
      const nextTags = uniqTags([...without, statusTag]);
      await db
        .from("message_contacts")
        .update({ ...base, tags: nextTags })
        .eq("id", existing.id);
    } else {
      await db.from("message_contacts").insert([
        {
          ...base,
          tags: [statusTag],
        },
      ]);
    }
  } catch (e) {
    console.warn(
      "[goat-leads-inbound] contact upsert failed:",
      e?.message || e
    );
  }
}

/* ---------------- auto-text helper ---------------- */

async function trySendNewLeadText({ user_id, lead_id, isMilitary, baseUrl }) {
  try {
    const base =
      (baseUrl || process.env.SITE_URL || process.env.URL || "").replace(
        /\/+$/,
        ""
      );

    if (!base) {
      console.warn(
        "[goat-leads-inbound] no base URL available for messages-send; skipping auto-text"
      );
      return;
    }

    const preferredKey = isMilitary ? "new_lead_military" : "new_lead";
    const url = `${base}/.netlify/functions/messages-send`;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        requesterId: user_id,
        lead_id,
        templateKey: preferredKey,
        billing: "free_first",
        preferFreeSegments: true,
        sent_by_ai: true,
        provider_message_id: `goat_new_lead_${lead_id}`, // dedupe-safe
      }),
    });

    const out = await res.json().catch(() => ({}));
    console.log("[goat-leads-inbound] messages-send response:", out);
    return out;
  } catch (e) {
    console.warn("[goat-leads-inbound] auto-text failed:", e?.message || e);
  }
}

/* ---------------- main handler ---------------- */

exports.handler = async (event) => {
  try {
    const qs = event.queryStringParameters || {};
    const token = qs.token || qs.Token || null;

    if (!token) {
      return json({ ok: false, error: "missing_token" }, 400);
    }

    // 1) Resolve user_id from agent_profiles.goat_webhook_token
    const { data: tokenRow, error: tokenErr } = await db
      .from("agent_profiles")
      .select("user_id")
      .eq("goat_webhook_token", token)
      .maybeSingle();

    if (tokenErr) {
      console.error("[goat-leads-inbound] token lookup error:", tokenErr);
      return json(
        {
          ok: false,
          error: "token_lookup_failed",
          detail: tokenErr.message || String(tokenErr),
        },
        500
      );
    }

    if (!tokenRow || !tokenRow.user_id) {
      return json({ ok: false, error: "invalid_token" }, 401);
    }

    const user_id = tokenRow.user_id;

    // 2) Parse JSON body
    let payload = {};
    try {
      payload = JSON.parse(event.body || "{}");
    } catch {
      return json({ ok: false, error: "invalid_json" }, 400);
    }

    const src = payload || {};

    // 3) Map Goat fields -> our schema

    const first_name = safeString(
      src.first_name,
      src.firstName,
      src["First Name"]
    );
    const last_name = safeString(
      src.last_name,
      src.lastName,
      src["Last Name"]
    );
    const combinedName = [first_name, last_name].filter(Boolean).join(" ");

    const name = safeString(src.name, src.Name, combinedName);

    const phoneRaw = firstNonEmpty(
      src.phone,
      src.phone_number,
      src["Phone"],
      src["Phone Number"],
      src.primary_phone,
      src["Primary Phone"]
    );
    const phone = toE164(phoneRaw);

    const email = safeString(src.email, src.Email);
    let state = safeString(
      src.state,
      src.State,
      src.region,
      src.Region,
      src.province,
      src.Province
    );
    if (state) state = state.toUpperCase();

    const dob = safeString(src.dob, src.DOB, src["Date of Birth"]);

    const beneficiary_name = safeString(
      src.beneficiary_name,
      src.beneficiaryName,
      src["Beneficiary Name"],
      src.Beneficiary
    );

    const gender = safeString(src.gender, src.Gender, src.sex, src.Sex);

    const military_status = safeString(
      src.military_branch,
      src.military_status,
      src["Military Status"],
      src["Veteran Status"],
      src["militaryBranch"]
    );
    const military_branch = military_status;

    if (!phone) {
      return json(
        {
          ok: false,
          error: "invalid_or_missing_phone",
          original: phoneRaw,
        },
        400
      );
    }

    // 4) Build insert row — ONLY columns that exist in your leads table:
    // user_id, status, name, phone, email, notes, dob, state, beneficiary,
    // beneficiary_name, company, gender, sold, created_at, updated_at,
    // owner_user_id, stage, stage_changed_at, next_follow_up_at,
    // last_outcome, call_attempts, priority, pipeline, military_branch

    const nowISO = new Date().toISOString();

    const row = {
      user_id,
      status: "lead",
      name: name,
      phone,
      email,
      dob,
      state,
      beneficiary: beneficiary_name,
      beneficiary_name,
      gender,
      military_branch,
      // pipeline defaults
      stage: "no_pickup",
      stage_changed_at: nowISO,
      // optional fields left null by default:
      notes: null,
      company: null,
      sold: null,
      owner_user_id: null,
      next_follow_up_at: null,
      last_outcome: null,
      call_attempts: 0,
      priority: "medium",
      pipeline: {},
    };

    // strip undefined so PostgREST doesn't complain
    Object.keys(row).forEach((k) => {
      if (row[k] === undefined) delete row[k];
    });

    // 5) Insert into `leads`
    const { data: ins, error: insErr } = await db
      .from("leads")
      .insert([row])
      .select("id, phone, name, military_branch")
      .single();

    if (insErr) {
      console.error("[goat-leads-inbound] insert error:", insErr);
      return json(
        {
          ok: false,
          error: "insert_lead_failed",
          detail: insErr.message || String(insErr),
          code: insErr.code || null,
        },
        500
      );
    }

    const lead_id = ins.id;

    // 6) Upsert into message_contacts (non-fatal if it fails)
    await upsertContactForLead({
      user_id,
      phone: ins.phone || phone,
      name: ins.name || name,
      military_branch: ins.military_branch || military_branch,
      lead_id,
    });

    // 7) Build base URL for messages-send (absolute, not relative)
    const headers = event.headers || {};
    const protoHeader =
      headers["x-forwarded-proto"] ||
      headers["X-Forwarded-Proto"] ||
      "https";
    const hostHeader = headers.host || headers.Host || "";
    const envSite =
      process.env.SITE_URL ||
      process.env.URL ||
      "";

    let baseUrl = envSite.replace(/\/+$/, "");
    if (!baseUrl) {
      const fallbackHost = envSite.replace(/^https?:\/\//, "");
      const host = hostHeader || fallbackHost;
      if (host) {
        baseUrl = `${protoHeader}://${host}`.replace(/\/+$/, "");
      }
    }

    // 8) Try auto-text (doesn't affect success/fail)
    const lowerBranch = String(
      ins.military_branch || military_branch || ""
    ).toLowerCase();
    const looksMilitary =
      lowerBranch.includes("vet") || lowerBranch.includes("military");

    trySendNewLeadText({
      user_id,
      lead_id,
      isMilitary: looksMilitary,
      baseUrl,
    }).catch(() => {});

    return json({ ok: true, lead_id });
  } catch (e) {
    console.error("[goat-leads-inbound] unhandled error:", e);
    return json(
      {
        ok: false,
        error: "unhandled",
        detail: e?.message || String(e),
      },
      500
    );
  }
};
