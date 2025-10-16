// netlify/functions/import-batch-send.js
// Bulk fan-out after CSV import, with DRY RUN + automatic contact upsert.
// Lead Rescue enrollment happens automatically via DB trigger.

const fetch = require("node-fetch");
const { getServiceClient } = require("./_supabase");

// --- Env flags ---
const ENV_ENABLED = String(process.env.CSV_IMPORT_AUTOSEND_ENABLED || "false").toLowerCase() === "true";
const BATCH_CAP = Number(process.env.IMPORT_BATCH_SEND_MAX || 500);
const THROTTLE_MS = Number(process.env.IMPORT_BATCH_SEND_DELAY_MS || 150);
const COST_CENTS = 1;
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
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

// ---- TFN lookup ----
async function getAgentTFNStatus(db, user_id) {
  if (BYPASS_TFN) return { status: "verified", e164: null, bypass: true };
  try {
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

// ---- Lead + contact helpers ----
async function findLeadByUserAndIdentity(db, user_id, { phone, email }) {
  const p10 = last10(phone || "");
  const em = S(email).toLowerCase();

  if (p10) {
    const variants = [p10, `1${p10}`, `+1${p10}`];
    const { data } = await db
      .from("leads")
      .select("id, name, phone, military_branch")
      .eq("user_id", user_id)
      .in("phone", variants)
      .order("created_at", { ascending: false })
      .limit(1);
    if (data?.length) return data[0];
    const { data: data2 } = await db
      .from("leads")
      .select("id, name, phone, military_branch")
      .eq("user_id", user_id)
      .ilike("phone", `%${p10}`)
      .order("created_at", { ascending: false })
      .limit(1);
    if (data2?.length) return data2[0];
  }

  if (em) {
    const { data } = await db
      .from("leads")
      .select("id, name, phone, military_branch")
      .eq("user_id", user_id)
      .ilike("email", em)
      .order("created_at", { ascending: false })
      .limit(1);
    if (data?.length) return data[0];
  }
  return null;
}

async function providerMessageIdExists(db, user_id, provider_message_id) {
  const { data } = await db
    .from("messages")
    .select("id")
    .eq("user_id", user_id)
    .eq("provider_message_id", provider_message_id)
    .limit(1);
  return !!(data && data.length);
}

// ---- Main handler ----
exports.handler = async (event) => {
  const db = getServiceClient();
  try {
    if (!ENV_ENABLED) return json({ error: "disabled" }, 403);

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
    if (people.length > BATCH_CAP) return json({ error: "over_cap", cap: BATCH_CAP }, 413);

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

      const lead = await findLeadByUserAndIdentity(db, requesterId, { phone: phoneE164, email });
      if (!lead) {
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

      queue.push({ lead, provider_message_id });
    }

    const will_send = queue.length;
    const estimated_cost_cents = will_send * COST_CENTS;

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
        will_send,
        estimated_cost_cents,
        wallet_balance_cents,
        skipped_by_reason,
        blocker,
      });
    }

    if (!BYPASS_TFN) {
      if (tfn.status === "pending") return json({ stop: "tfn_pending_verification" }, 409);
      if (tfn.status !== "verified") return json({ stop: "no_agent_tfn_configured" }, 409);
    }
    if (wallet_balance_cents < estimated_cost_cents)
      return json({ stop: "insufficient_balance" }, 402);

    let ok = 0,
      errors = 0,
      skipped = people.length - will_send;

    for (const item of queue) {
      const lead = item.lead;
      try {
        // --- Upsert into message_contacts (trigger handles Lead Rescue)
        if (lead.phone) {
          const e164 = toE164(lead.phone);
          const tag = S(lead.military_branch) ? "military" : "lead";
          const { data: existing } = await db
            .from("message_contacts")
            .select("id, phone, tags")
            .eq("user_id", requesterId)
            .order("created_at", { ascending: false });

          const found = (existing || []).find((r) => onlyDigits(r.phone) === onlyDigits(e164));
          const base = {
            user_id: requesterId,
            phone: e164,
            full_name: lead.name || null,
            subscribed: true,
            meta: { lead_id: lead.id },
          };

          if (found?.id) {
            const cur = Array.isArray(found.tags) ? found.tags : [];
            const nextTags = Array.from(new Set([...cur.filter(t => !["lead","military"].includes(String(t).toLowerCase())), tag]));
            await db.from("message_contacts").update({ ...base, tags: nextTags }).eq("id", found.id);
            console.log("[import-batch-send] updated existing contact", found.id);
          } else {
            await db.from("message_contacts").insert([{ ...base, tags: [tag] }]);
            console.log("[import-batch-send] inserted new contact for", e164);
          }
        }

        // --- Send message
        const res = await fetch(ABS_SEND_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            requesterId,
            lead_id: lead.id,
            provider_message_id: item.provider_message_id,
          }),
        });
        const out = await res.json().catch(() => ({}));
        if (res.ok && (out.ok || out.deduped)) ok++;
        else {
          errors++;
          console.warn("[import-batch-send] message-send failed", out);
        }
      } catch (err) {
        errors++;
        console.warn("[import-batch-send] loop error:", err.message || err);
      }
      if (THROTTLE_MS > 0) await sleep(THROTTLE_MS);
    }

    return json({
      mode: "send",
      batch_id: batchId,
      ok,
      skipped,
      errors,
      will_send,
      estimated_cost_cents,
    });
  } catch (e) {
    console.error("[import-batch-send] unhandled:", e);
    return json({ error: "unhandled", detail: String(e?.message || e) }, 500);
  }
};
