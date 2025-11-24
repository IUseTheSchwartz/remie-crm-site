// netlify/functions/goat-leads-inbound.js
// Accepts Goat Leads (or test JSON) and inserts into `leads` for the user
// whose token matches ?token=... in the URL. Also can trigger auto-text
// via messages-send (new_lead / new_lead_military) if templates + toggle
// are enabled, and upserts a matching message_contacts row.

const { getServiceClient } = require("./_supabase");
const fetch = require("node-fetch");

const FN_BASE =
  process.env.FN_BASE ||
  process.env.VITE_FUNCTIONS_BASE ||
  "/.netlify/functions";

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

function firstNonEmpty(...vals) {
  for (const v of vals) {
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return null;
}

function safeString(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

// Small helpers for tags/strings (match other functions)
const S = (v) =>
  v == null ? "" : typeof v === "string" ? v.trim() : String(v).trim();
const normalizeTag = (s) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, "_");
const uniqTags = (arr) =>
  Array.from(new Set((arr || []).map(normalizeTag))).filter(Boolean);

/* ---------------- auto-text helper ---------------- */

// Build absolute base URL inside Netlify (same pattern as zap-webhook)
function resolveBaseUrl(event) {
  const proto =
    event.headers["x-forwarded-proto"] ||
    event.headers["X-Forwarded-Proto"] ||
    "https";
  const host =
    event.headers.host ||
    (process.env.URL || process.env.SITE_URL || "").replace(/^https?:\/\//, "");
  const envBase = process.env.SITE_URL || process.env.URL || null;
  if (envBase) return envBase.replace(/\/$/, "");
  if (proto && host) return `${proto}://${host}`;
  return null;
}

async function trySendNewLeadText({ user_id, lead_id, isMilitary, event }) {
  try {
    const base = resolveBaseUrl(event);
    if (!base) {
      console.warn("[goat-leads-inbound] could not resolve base URL for messages-send");
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
    console.log("[goat-leads-inbound] messages-send response:", res.status, out);
    return out;
  } catch (e) {
    console.warn("[goat-leads-inbound] auto-text failed:", e?.message || e);
  }
}

/* ---------------- main handler ---------------- */

exports.handler = async (event) => {
  const db = getServiceClient();

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
    const name = safeString(
      src.name,
      src.Name,
      [first_name, last_name].filter(Boolean).join(" ")
    );

    const phoneRaw = firstNonEmpty(
      src.phone,
      src.phone_number,
      src["Phone"],
      src["Phone Number"]
    );
    const phone = toE164(phoneRaw);

    const email = safeString(src.email, src.Email);
    const state = safeString(src.state, src.State, src.Region, src.Province);

    const dob = safeString(src.dob, src.DOB, src["Date of Birth"]);
    const beneficiary_name = safeString(
      src.beneficiary_name,
      src["Beneficiary Name"],
      src.Beneficiary
    );

    const gender = safeString(src.gender, src.Gender);

    const military_status = safeString(
      src.military_branch,
      src.military_status,
      src["Military Status"]
    );
    const military_branch = military_status;

    // we don't have lead_type/source columns on the leads table, so we don't insert them

    if (!phone) {
      return json(
        { ok: false, error: "invalid_or_missing_phone", original: phoneRaw },
        400
      );
    }

    // 4) Build insert row — ONLY columns that exist in your leads table:
    // user_id, status, name, phone, email, notes, dob, state, beneficiary,
    // beneficiary_name, company, gender, sold, created_at, updated_at,
    // owner_user_id, stage, stage_changed_at, next_follow_up_at,
    // last_outcome, call_attempts, priority, pipeline, military_branch

    const row = {
      user_id,
      status: "lead",
      name,
      phone,
      email,
      dob,
      state,
      beneficiary: beneficiary_name,
      beneficiary_name,
      gender,
      military_branch,
      // optional fields left null by default:
      notes: null,
      company: null,
      sold: null,
      owner_user_id: null,
      stage: null,
      stage_changed_at: null,
      next_follow_up_at: null,
      last_outcome: null,
      call_attempts: null,
      priority: null,
      pipeline: null,
    };

    // strip undefined so PostgREST doesn't complain
    Object.keys(row).forEach((k) => {
      if (row[k] === undefined) delete row[k];
    });

    // 5) Insert into `leads`
    const { data: ins, error: insErr } = await db
      .from("leads")
      .insert([row])
      .select("id, name, phone, military_branch")
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

    /* 6) Upsert message_contacts entry (so Contact page stays in sync) */
    try {
      if (ins.phone) {
        const e164 = toE164(ins.phone);
        if (e164) {
          const phoneDigits = onlyDigits(e164);

          const { data: existingRows, error: selErr } = await db
            .from("message_contacts")
            .select("id, phone, tags")
            .eq("user_id", user_id)
            .order("created_at", { ascending: false });

          if (selErr) throw selErr;

          const existing =
            (existingRows || []).find(
              (r) => onlyDigits(r.phone) === phoneDigits
            ) || null;

          const statusTag = S(ins.military_branch) ? "military" : "lead";
          const base = {
            user_id,
            phone: e164,
            full_name: ins.name || null,
            subscribed: true,
            meta: { lead_id },
          };

          if (existing?.id) {
            const cur = Array.isArray(existing.tags) ? existing.tags : [];
            const withoutStatus = cur.filter(
              (t) =>
                !["lead", "military"].includes(String(t).toLowerCase())
            );
            const nextTags = uniqTags([...withoutStatus, statusTag]);
            await db
              .from("message_contacts")
              .update({ ...base, tags: nextTags })
              .eq("id", existing.id);
          } else {
            await db
              .from("message_contacts")
              .insert([{ ...base, tags: [statusTag] }]);
          }
        }
      }
    } catch (e) {
      console.warn(
        "[goat-leads-inbound] contact upsert warning:",
        e?.message || e
      );
      // non-fatal
    }

    // 7) Try auto-text (doesn't affect success/fail)
    const looksMilitary =
      (military_branch || "").toLowerCase().includes("vet") ||
      (military_branch || "").toLowerCase().includes("military");
    trySendNewLeadText({
      user_id,
      lead_id,
      isMilitary: looksMilitary,
      event,
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
