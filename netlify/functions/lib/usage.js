// netlify/functions/lib/usage.js
// Monthly free-pool usage helpers for SMS + Calls

const { DateTime } = require("luxon");

/** Resolve an account_id for pooling.
 *  Prefers subscriptions.account_id; falls back to user_id (solo).
 */
async function resolveAccountId(db, user_id) {
  // Try an active subscription-owned account
  const { data: sub } = await db
    .from("subscriptions")
    .select("account_id")
    .eq("user_id", user_id)
    .eq("status", "active")
    .limit(1);
  if (sub && sub[0]?.account_id) return sub[0].account_id;
  // Fallback: pool per-user
  return user_id;
}

function monthWindow(nowISO) {
  const now = DateTime.fromISO(nowISO || new Date().toISOString());
  const start = now.startOf("month");
  const end = start.plus({ months: 1 });
  return { period_start: start.toUTC().toISO(), period_end: end.toUTC().toISO() };
}

/** Ensure a usage_counters row exists for this account & month. */
async function ensureUsageRow(db, account_id, nowISO) {
  const { period_start, period_end } = monthWindow(nowISO);
  // Upsert-like: try find, then insert if not
  const { data: existing, error: findErr } = await db
    .from("usage_counters")
    .select("id, free_sms_total, free_sms_used, free_call_seconds_total, free_call_seconds_used")
    .eq("account_id", account_id)
    .eq("period_start", period_start)
    .eq("period_end", period_end)
    .limit(1);
  if (findErr) throw findErr;
  if (existing && existing.length) return existing[0];

  const { data: inserted, error: insErr } = await db
    .from("usage_counters")
    .insert([{ account_id, period_start, period_end }])
    .select("id, free_sms_total, free_sms_used, free_call_seconds_total, free_call_seconds_used")
    .single();
  if (insErr) throw insErr;
  return inserted;
}

/** Conservative SMS segment counter (GSM-7 vs UCS-2 fallback). */
function countSmsSegments(text = "") {
  const s = String(text);
  // Very-lightweight GSM-7 detector (good enough for caps):
  const gsm7 =
    /^[\n\r\t\0\x0B\x0C\x1B\x20-\x7E€£¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ^{}\[~\]|€\\]*$/.test(s);
  if (gsm7) {
    const singleLimit = 160, concatLimit = 153;
    if (s.length <= singleLimit) return 1;
    return Math.ceil(s.length / concatLimit);
  } else {
    // UCS-2
    const singleLimit = 70, concatLimit = 67;
    if (s.length <= singleLimit) return 1;
    return Math.ceil(s.length / concatLimit);
  }
}

/** Try to consume N SMS segments. Returns {covered, remaining_to_bill}. */
async function tryConsumeSms(db, account_id, segments, nowISO) {
  await ensureUsageRow(db, account_id, nowISO);
  const { period_start, period_end } = monthWindow(nowISO);

  // Atomic update: only succeed if we have room
  const { data, error } = await db
    .rpc("usage_consume_sms", { // prefer SQL function; fallback below if you don't add it
      p_account_id: account_id,
      p_period_start: period_start,
      p_period_end: period_end,
      p_segments: segments
    });

  if (error && error.code === "PGRST116") {
    // No RPC: use a conditional UPDATE … WHERE free_sms_used + segments <= total
    const { data: updated, error: updErr } = await db
      .from("usage_counters")
      .update({ free_sms_used: db.rpc ? undefined : undefined }) // placeholder; see next block
      .eq("account_id", account_id)
      .eq("period_start", period_start)
      .eq("period_end", period_end)
      .lte("free_sms_used", 1e12) // noop predicate to keep builder happy
      .select("free_sms_total, free_sms_used");

    // We can't do a single-statement check with the JS builder.
    // Instead, re-fetch then do a best-effort split (small race risk under extreme concurrency).
  }

  // Instead of the above hack, use two-phase approach:
  const { data: row0, error: getErr } = await db
    .from("usage_counters")
    .select("id, free_sms_total, free_sms_used")
    .eq("account_id", account_id)
    .eq("period_start", period_start)
    .eq("period_end", period_end)
    .single();
  if (getErr) throw getErr;

  const remaining = Math.max(0, row0.free_sms_total - row0.free_sms_used);
  const covered = Math.min(remaining, segments);
  const over = segments - covered;

  if (covered > 0) {
    const { error: updErr2 } = await db
      .from("usage_counters")
      .update({ free_sms_used: row0.free_sms_used + covered, updated_at: new Date().toISOString() })
      .eq("id", row0.id);
    if (updErr2) throw updErr2;
  }

  return { covered, remaining_to_bill: over };
}

/** Try to consume call seconds. Returns {covered, remaining_to_bill}. */
async function tryConsumeCallSeconds(db, account_id, seconds, nowISO) {
  await ensureUsageRow(db, account_id, nowISO);
  const { period_start, period_end } = monthWindow(nowISO);

  const { data: row0, error: getErr } = await db
    .from("usage_counters")
    .select("id, free_call_seconds_total, free_call_seconds_used")
    .eq("account_id", account_id)
    .eq("period_start", period_start)
    .eq("period_end", period_end)
    .single();
  if (getErr) throw getErr;

  const remaining = Math.max(0, row0.free_call_seconds_total - row0.free_call_seconds_used);
  const covered = Math.min(remaining, seconds);
  const over = seconds - covered;

  if (covered > 0) {
    const { error: updErr2 } = await db
      .from("usage_counters")
      .update({
        free_call_seconds_used: row0.free_call_seconds_used + covered,
        updated_at: new Date().toISOString(),
      })
      .eq("id", row0.id);
    if (updErr2) throw updErr2;
  }

  return { covered, remaining_to_bill: over };
}

module.exports = {
  resolveAccountId,
  ensureUsageRow,
  monthWindow,
  countSmsSegments,
  tryConsumeSms,
  tryConsumeCallSeconds,
};
