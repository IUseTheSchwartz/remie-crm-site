// netlify/functions/goat-leads-inbound.js
// Accepts Goat Leads (or test JSON) and inserts into `leads` for the user
// whose token matches ?token=... in the URL. Also can trigger auto-text
// via messages-send (new_lead / new_lead_military) if templates + toggle
// are enabled.

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

/* ---------------- auto-text helper ---------------- */

async function trySendNewLeadText({ user_id, lead_id, isMilitary }) {
  try {
    // This function uses service role; we just call messages-send directly.
    const url = `${FN_BASE.replace(/\/$/, "")}/messages-send`;

    const preferredKey = isMilitary ? "new_lead_military" : "new_lead";

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // tell messages-send which user this is if it can't derive from lead_id
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

    // We don't fail the webhook if texting fails; just log it.
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

    // 1) Resolve user_id from token
    const { data: tokenRow, error: tokenErr } = await db
      .from("goat_webhook_tokens")
      .select("user_id")
      .eq("token", token)
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
    const military_branch = military_status; // we just store the text

    const lead_type = safeString(
      src.lead_type,
      src["Lead Type"],
      src["Lead Sub-Type"]
    );

    const source = safeString(
      src.source,
      src.Source,
      src["Aged Bucket"] ? `goat_${src["Aged Bucket"]}` : "goat_leads"
    );

    if (!phone) {
      return json(
        { ok: false, error: "invalid_or_missing_phone", original: phoneRaw },
        400
      );
    }

    // 4) Build insert row — only columns we know exist
    const row = {
      user_id,
      name,
      phone,
      email,
      state,
      dob,
      beneficiary: beneficiary_name, // keep both filled
      beneficiary_name,
      gender,
      military_branch,
      lead_type,
      source,
      // stage, status, created_at, etc. should default in DB
    };

    // Remove undefined to avoid Postgrest complaining
    Object.keys(row).forEach((k) => {
      if (row[k] === undefined) delete row[k];
    });

    // 5) Insert into `leads`
    const { data: ins, error: insErr } = await db
      .from("leads")
      .insert([row])
      .select("id")
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

    // 6) Try auto-text (doesn't affect success/fail)
    const looksMilitary =
      (military_branch || "").toLowerCase().includes("vet") ||
      (military_branch || "").toLowerCase().includes("military");
    trySendNewLeadText({ user_id, lead_id, isMilitary: looksMilitary }).catch(
      () => {}
    );

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
