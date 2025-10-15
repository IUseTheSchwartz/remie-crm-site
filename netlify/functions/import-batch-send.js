// netlify/functions/import-batch-send.js
// Bulk fan-out after CSV import, with DRY RUN + cost preview.
// Robust TFN detection + tolerant phone matching (last-10 suffix ILIKE).

const fetch = require("node-fetch");
const { getServiceClient } = require("./_supabase");

// --- Env flags ---
const ENV_ENABLED = String(process.env.CSV_IMPORT_AUTOSEND_ENABLED || "false").toLowerCase() === "true";
const BATCH_CAP = Number(process.env.IMPORT_BATCH_SEND_MAX || 500);
const THROTTLE_MS = Number(process.env.IMPORT_BATCH_SEND_DELAY_MS || 150);
const COST_CENTS = 1; // must match messages-send.js
const BYPASS_TFN = String(process.env.CSV_IMPORT_BYPASS_TFN || "false").toLowerCase() === "true";

// Optional absolute override; otherwise use the function path
const ABS_SEND_URL =
  process.env.SEND_FN_ABS_URL ||
  `${process.env.URL || ""}/.netlify/functions/messages-send`;

// ---- helpers ----
const S = (x) => (x == null ? "" : String(x).trim());
const onlyDigits = (s) => String(s || "").replace(/\D/g, "");
const last10 = (p) => onlyDigits(p).slice(-10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function toE164(p) {
  const d = onlyDigits(p);
  if (!d) return null;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  if (d.length === 10) return `+1${d}`;
  if (String(p || "").startsWith("+")) return String(p);
  return null;
}

function json(body, statusCode = 200) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

// ---- TFN lookup (compatible with your schema) ----
async function getAgentTFNStatus(db, user_id) {
  if (BYPASS_TFN) return { status: "verified", e164: null, bypass: true };

  try {
    // Your schema: public.toll_free_numbers (assigned_to, verified, phone_number)
    const { data, error } = await db
      .from("toll_free_numbers")
      .select("phone_number, verified")
      .eq("assigned_to", user_id)
      .order("verified", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!data) return { status: "none" };
    const phone = toE164(data.phone_number);
    if (!phone) return { status: "none" };
    return data.verified ? { status: "verified", e164: phone } : { status: "pending", e164: phone };
  } catch (e) {
    console.warn("[tfn] lookup error:", e.message || e);
    return { status: "none" };
  }
}

async function getBalanceCents(db, user_id) {
  const { data, error } = await db
    .from("user_wallets")
    .select("balance_cents")
    .eq("user_id", user_id)
    .maybeSingle();
  if (error) throw error;
  return Number(data?.balance_cents ?? 0);
}

async function getContactByPhone(db, user_id, phoneE164) {
  const { data, error } = await db
    .from("message_contacts")
    .select("id, subscribed, tags")
    .eq("user_id", user_id)
    .eq("phone", phoneE164)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

// ---- Tolerant lead match: exact E.164 OR suffix ILIKE on last-10 ----
async function findLeadIdByUserAndIdentity(db, user_id, { phone, email }) {
  const p10 = last10(phone || "");
  const em = S(email).toLowerCase();

  // 1) Exact phone matches for common variants (fast path)
  if (p10) {
    const variants = [p10, `1${p10}`, `+1${p10}`];

    try {
      const { data, error } = await db
        .from("leads")
        .select("id, phone")
        .eq("user_id", user_id)
        .in("phone", variants)
        .order("created_at", { ascending: false })
        .limit(1);
      if (error) throw error;
      if (data?.length) return data[0].id;
    } catch (e) {
      console.warn("[lead match] exact variants error:", e.message || e);
    }

    // 2) Suffix ILIKE on last-10 (handles formatting like (555) 123-4567, etc.)
    try {
      const { data, error } = await db
        .from("leads")
        .select("id, phone")
        .eq("user_id", user_id)
        .ilike("phone", `%${p10}`) // ends with last 10
        .order("created_at", { ascending: false })
        .limit(1);
      if (error) throw error;
      if (data?.length) return data[0].id;
    } catch (e) {
      console.warn("[lead match] suffix ilike error:", e.message || e);
    }
  }

  // 3) Email match (case-insensitive)
  if (em) {
    try {
      const { data, error } = await db
        .from("leads")
        .select("id")
        .eq("user_id", user_id)
        .ilike("email", em)
        .order("created_at", { ascending: false })
        .limit(1);
      if (error) throw error;
      if (data?.length) return data[0].id;
    } catch (e) {
      console.warn("[lead match] email ilike error:", e.message || e);
    }
  }

  return null;
}

async function providerMessageIdExists(db, user_id, provider_message_id) {
  const { data, error } = await db
    .from("messages")
    .select("id")
    .eq("user_id", user_id)
    .eq("provider_message_id", provider_message_id)
    .limit(1);
  if (error) throw error;
  return !!(data && data.length);
}

exports.handler = async (event) => {
  const db = getServiceClient();
  try {
    if (!ENV_ENABLED) {
      return json({ error: "disabled", hint: "CSV_IMPORT_AUTOSEND_ENABLED=false" }, 403);
    }

    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json({ error: "invalid_json" }, 400);
    }

    const requesterId = S(body.requesterId);
    const dryRun = !!body.dry_run;
    const batchId = S(body.batch_id) || Math.random().toString(36).slice(2, 10);
    const people = Array.isArray(body.people) ? body.people : [];

    if (!requesterId) return json({ error: "missing_requesterId" }, 400);
    if (!people.length) return json({ error: "no_people" }, 400);

    const total_candidates = people.length;
    if (total_candidates > BATCH_CAP) {
      return json({ error: "over_cap", cap: BATCH_CAP, total_candidates }, 413);
    }

    // Pre-flight blockers shared by both dry run and real run
    const tfn = await getAgentTFNStatus(db, requesterId);
    const wallet_balance_cents = await getBalanceCents(db, requesterId);

    const skipped_by_reason = {
      unsubscribed: 0,
      invalid_phone: 0,
      no_lead_match: 0,
      already_deduped: 0,
    };

    const queue = [];

    for (const p of people) {
      const phoneE164 = toE164(p.phone || "");
      const email = S(p.email).toLowerCase();

      if (!phoneE164 && !email) {
        skipped_by_reason.invalid_phone++;
        continue;
      }

      // Respect unsubscribed if we can resolve a phone
      if (phoneE164) {
        const c = await getContactByPhone(db, requesterId, phoneE164).catch(() => null);
        if (c && c.subscribed === false) {
          skipped_by_reason.unsubscribed++;
          continue;
        }
      }

      const lead_id = await findLeadIdByUserAndIdentity(db, requesterId, { phone: phoneE164, email });
      if (!lead_id) {
        skipped_by_reason.no_lead_match++;
        continue;
      }

      const keyTail = phoneE164 ? last10(phoneE164) : Buffer.from(email).toString("hex").slice(0, 10);
      const provider_message_id = `csv-${batchId}-${keyTail}`;

      const exists = await providerMessageIdExists(db, requesterId, provider_message_id);
      if (exists) {
        skipped_by_reason.already_deduped++;
        continue;
      }

      queue.push({ lead_id, provider_message_id });
    }

    const will_send = queue.length;
    const estimated_cost_cents = will_send * COST_CENTS;

    // Dry run returns preview + blockers (don’t attempt send)
    if (dryRun) {
      let blocker = null;
      if (!BYPASS_TFN) {
        if (tfn.status === "pending") blocker = "tfn_pending_verification";
        else if (tfn.status !== "verified") blocker = "no_agent_tfn_configured";
      }
      if (wallet_balance_cents < estimated_cost_cents) blocker = "insufficient_balance";

      return json({
        mode: "dry_run",
        batch_id: batchId,
        total_candidates,
        will_send,
        estimated_cost_cents,
        wallet_balance_cents,
        skipped_by_reason,
        blocker,
        tfn_status: tfn.status,
        tfn_bypass: BYPASS_TFN,
      });
    }

    // Real run: stop on blockers up front
    if (!BYPASS_TFN) {
      if (tfn.status === "pending") return json({ stop: "tfn_pending_verification" }, 409);
      if (tfn.status !== "verified") return json({ stop: "no_agent_tfn_configured" }, 409);
    }
    if (wallet_balance_cents < estimated_cost_cents)
      return json({ stop: "insufficient_balance", needed_cents: estimated_cost_cents, wallet_balance_cents }, 402);

    // Fan-out to messages-send
    let ok = 0,
      errors = 0,
      skipped = total_candidates - will_send;

    for (const item of queue) {
      try {
        const res = await fetch(ABS_SEND_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            requesterId,
            lead_id: item.lead_id,
            provider_message_id: item.provider_message_id,
            // templateKey left undefined: messages-send chooses correct template.
          }),
        });

        const out = await res.json().catch(() => ({}));

        if (res.ok && (out.ok || out.deduped)) {
          ok++;

          // Auto-enroll in Lead Rescue (after successful send)
          try {
            const contactId = out?.contact_id;
            if (contactId) {
              await db.from("lead_rescue_trackers").upsert(
                {
                  user_id: requesterId,
                  contact_id: contactId,
                  seq_key: "lead_rescue",
                  current_day: 1,
                  started_at: new Date().toISOString(),
                },
                { onConflict: "user_id,contact_id,seq_key" }
              );
            }
          } catch (err) {
            console.warn("[import-batch-send] lead_rescue_trackers insert warning:", err.message || err);
          }
        } else {
          errors++;
        }
      } catch {
        errors++;
      }

      if (THROTTLE_MS > 0) await sleep(THROTTLE_MS);
    }

    return json({
      mode: "send",
      batch_id: batchId,
      ok,
      skipped,
      errors,
      total_candidates,
      will_send,
      estimated_cost_cents,
    });
  } catch (e) {
    console.error("[import-batch-send] unhandled:", e);
    return json({ error: "unhandled", detail: String(e?.message || e) }, 500);
  }
};
