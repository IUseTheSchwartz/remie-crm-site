// netlify/functions/telnyx-voice-webhook.js
// LEAD-FIRST flow: Lead phone rings first (from call-start). On lead answer → play ringback to lead,
// transfer to agent, bridge on agent answer. Logs to call_logs, handles optional recording, free minutes,
// and wallet debit. Marks lead stage=answered on bridge when contact_id is known.

const crypto = require("crypto");
const fetch = require("node-fetch");
const { createClient } = require("@supabase/supabase-js");

const TELNYX_API_KEY = process.env.TELNYX_API_KEY || "";
const TELNYX_WEBHOOK_SECRET = process.env.TELNYX_WEBHOOK_SECRET || ""; // optional HMAC
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE || "";

const supa = (SUPABASE_URL && SUPABASE_SERVICE_ROLE)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE)
  : null;

function log(...args) { try { console.log("[telnyx-webhook]", ...args); } catch {} }

/* ===================================================================
   Monthly free-pool helpers (usage_counters for CALL MINUTES)
   =================================================================== */
async function resolveAccountId(user_id) {
  if (!supa || !user_id) return user_id;
  try {
    const { data } = await supa
      .from("subscriptions")
      .select("account_id, status")
      .eq("user_id", user_id)
      .eq("status", "active")
      .limit(1);
    if (data && data[0]?.account_id) return data[0].account_id;
  } catch {}
  return user_id;
}

function monthWindow(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0));
  return { period_start: start.toISOString(), period_end: end.toISOString() };
}

async function ensureUsageRowMinutes(account_id, now = new Date()) {
  if (!supa || !account_id) return null;
  const { period_start, period_end } = monthWindow(now);

  const { data: existing } = await supa
    .from("usage_counters")
    .select("id, free_call_minutes_total, free_call_minutes_used")
    .eq("account_id", account_id)
    .eq("period_start", period_start)
    .eq("period_end", period_end)
    .limit(1);
  if (existing && existing[0]) return existing[0];

  const { data: inserted } = await supa
    .from("usage_counters")
    .insert([{ account_id, period_start, period_end }])
    .select("id, free_call_minutes_total, free_call_minutes_used")
    .single();

  if (inserted) return inserted;

  // race fallback
  const { data: again } = await supa
    .from("usage_counters")
    .select("id, free_call_minutes_total, free_call_minutes_used")
    .eq("account_id", account_id)
    .eq("period_start", period_start)
    .eq("period_end", period_end)
    .limit(1);
  return (again && again[0]) || null;
}

async function tryConsumeCallMinutes(account_id, minutes, now = new Date()) {
  if (!supa || !account_id || !minutes || minutes <= 0) {
    return { covered: 0, remaining_to_bill: minutes || 0 };
  }
  await ensureUsageRowMinutes(account_id, now);
  const { period_start, period_end } = monthWindow(now);

  const { data: row0 } = await supa
    .from("usage_counters")
    .select("id, free_call_minutes_total, free_call_minutes_used")
    .eq("account_id", account_id)
    .eq("period_start", period_start)
    .eq("period_end", period_end)
    .single();

  if (!row0) return { covered: 0, remaining_to_bill: minutes };

  const remaining = Math.max(0, (row0.free_call_minutes_total || 0) - (row0.free_call_minutes_used || 0));
  const covered = Math.min(remaining, minutes);
  const over = minutes - covered;

  if (covered > 0) {
    const { error: updErr } = await supa
      .from("usage_counters")
      .update({
        free_call_minutes_used: (row0.free_call_minutes_used || 0) + covered,
        updated_at: new Date().toISOString(),
      })
      .eq("id", row0.id);
    if (updErr) log("usage minutes update err", updErr.message);
  }

  return { covered, remaining_to_bill: over };
}
/* =================================================================== */

/* ---------------- Signature verify (optional) ---------------- */
function verifySignature(rawBody, signatureHeader) {
  if (!TELNYX_WEBHOOK_SECRET) return true;
  if (!signatureHeader) return false;
  try {
    const parts = String(signatureHeader).split(",").map(s => s.trim());
    const ts = parts.find(p => p.startsWith("t="))?.split("=")[1];
    const sig = parts.find(p => p.startsWith("sig="))?.split("=")[1];
    if (!ts || !sig) return false;
    const payload = `${ts}.${rawBody}`;
    const hmac = crypto.createHmac("sha256", TELNYX_WEBHOOK_SECRET);
    hmac.update(payload);
    const digest = hmac.digest("hex");
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(sig));
  } catch { return false; }
}

/* ---------------- client_state helpers ---------------- */
function decodeClientState(any) {
  try {
    if (!any) return null;
    if (typeof any === "object") return any;
    const s = String(any);
    if (/^[A-Za-z0-9+/=]+={0,2}$/.test(s)) {
      const json = Buffer.from(s, "base64").toString("utf8");
      return JSON.parse(json);
    }
    return JSON.parse(s);
  } catch { return null; }
}

/* ---------------- Telnyx helpers ---------------- */
async function transferCall({ callControlId, to, from }) {
  if (!TELNYX_API_KEY) { log("transfer skipped: no TELNYX_API_KEY"); return; }
  const url = `https://api.telnyx.com/v2/calls/${callControlId}/actions/transfer`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${TELNYX_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ to, from })
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) log("transfer failed", resp.status, data);
  else log("transfer ok", { to, from });
}

async function startRecording(callControlId) {
  try {
    if (!TELNYX_API_KEY || !callControlId) return;
    const url = `https://api.telnyx.com/v2/calls/${callControlId}/actions/record_start`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${TELNYX_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ channels: "dual", audio: { direction: "both" }, format: "mp3" })
    });
    if (!resp.ok) {
      const j = await resp.json().catch(() => ({}));
      log("record_start failed", resp.status, j);
    } else {
      log("record_start ok");
    }
  } catch (e) { log("record_start error", e?.message); }
}

async function playbackStart(callControlId, audioUrl) {
  try {
    if (!TELNYX_API_KEY || !callControlId || !audioUrl) return;
    const url = `https://api.telnyx.com/v2/calls/${callControlId}/actions/playback_start`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${TELNYX_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ audio_url: audioUrl, loop: true })
    });
    if (!resp.ok) {
      const j = await resp.json().catch(() => ({}));
      log("playback_start failed", resp.status, j);
    } else {
      log("playback_start ok");
    }
  } catch (e) { log("playback_start error", e?.message); }
}

async function playbackStop(callControlId) {
  try {
    if (!TELNYX_API_KEY || !callControlId) return;
    const url = `https://api.telnyx.com/v2/calls/${callControlId}/actions/playback_stop`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${TELNYX_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
    if (!resp.ok) {
      const j = await resp.json().catch(() => ({}));
      log("playback_stop failed", resp.status, j);
    } else {
      log("playback_stop ok");
    }
  } catch (e) { log("playback_stop error", e?.message); }
}

async function hangupCall(callControlId) {
  try {
    if (!TELNYX_API_KEY || !callControlId) return;
    const url = `https://api.telnyx.com/v2/calls/${callControlId}/actions/hangup`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${TELNYX_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
    if (!resp.ok) {
      const j = await resp.json().catch(() => ({}));
      log("hangup failed", resp.status, j);
    } else {
      log("hangup ok");
    }
  } catch (e) { log("hangup error", e?.message); }
}

/* ---------------- Wallet / DB helpers ---------------- */
async function debitWalletForCall({ legA, user_id, cents }) {
  if (!supa || !legA || !user_id || !cents || cents <= 0) return { ok: true, skipped: true };
  const { data, error } = await supa.rpc("wallet_debit_for_call", {
    _leg_a: legA,
    _user_id: user_id,
    _amount_cents: cents,
  });
  if (error) {
    log("wallet_debit_for_call err", error.message);
    return { ok: false, error: error.message };
  }
  return { ok: true, data };
}

async function upsertInitiated({
  user_id, contact_id, to_number, from_number, agent_number,
  legA, call_session_id, started_at, record_enabled
}) {
  if (!supa) return;
  const { data: existing } = await supa
    .from("call_logs")
    .select("id")
    .eq("telnyx_leg_a_id", legA)
    .limit(1)
    .maybeSingle();

  const baseFields = {
    user_id, contact_id,
    to_number, from_number, agent_number,
    status: "ringing",
    started_at: started_at || new Date().toISOString(),
    record_enabled: !!record_enabled,
  };
  if (call_session_id) baseFields.call_session_id = call_session_id;

  if (existing?.id) {
    const { error } = await supa.from("call_logs").update(baseFields).eq("id", existing.id);
    if (error) log("upsert initiated (update) err", error.message);
  } else {
    const { error } = await supa.from("call_logs").insert({
      direction: "outbound",
      telnyx_leg_a_id: legA,
      ...baseFields,
    });
    if (error) log("upsert initiated (insert) err", error.message);
  }
}

async function markAnswered({ legA, answered_at }) {
  if (!supa || !legA) return;
  const { error } = await supa
    .from("call_logs")
    .update({ status: "answered", answered_at: answered_at || new Date().toISOString() })
    .eq("telnyx_leg_a_id", legA);
  if (error) log("markAnswered err", error.message);
}

async function markBridged({ legA, maybeLegB }) {
  if (!supa || !legA) return;
  const updates = { status: "bridged" };
  if (maybeLegB) updates.telnyx_leg_b_id = maybeLegB;
  const { error } = await supa.from("call_logs").update(updates).eq("telnyx_leg_a_id", legA);
  if (error) log("markBridged err", error.message);
}

async function saveRecordingUrlByCallSession({ call_session_id, recording_url }) {
  if (!supa || !call_session_id || !recording_url) return;
  const { error } = await supa.from("call_logs").update({ recording_url }).eq("call_session_id", call_session_id);
  if (error) log("saveRecordingUrl err", error.message);
}

/* ---- Lead pipeline helper: mark stage=answered when bridged ---- */
async function markLeadAnsweredStage({ contact_id }) {
  if (!supa || !contact_id) return;
  try {
    await supa
      .from("leads")
      .update({ stage: "answered", stage_changed_at: new Date().toISOString() })
      .eq("id", contact_id);
  } catch (e) {
    log("markLeadAnsweredStage err", e?.message);
  }
}

/* ---------------- END logic (MINUTES pool) ---------------- */
async function markEnded({ legA, ended_at, hangup_cause }) {
  if (!supa || !legA) return;

  const endedISO = ended_at || new Date().toISOString();

  const { data: row } = await supa
    .from("call_logs")
    .select("started_at, user_id, record_enabled")
    .eq("telnyx_leg_a_id", legA)
    .maybeSingle();

  const startedAt = row?.started_at || null;
  const user_id = row?.user_id || null;
  const record_enabled = !!row?.record_enabled;

  let duration_seconds = null;
  if (startedAt) {
    const t0 = new Date(startedAt).getTime();
    const t1 = new Date(endedISO).getTime();
    duration_seconds = Math.max(0, Math.round((t1 - t0) / 1000));
  }

  // Default: failure if non-normal cause
  const failed = hangup_cause && hangup_cause !== "normal_clearing";

  // Per-minute rate (keep your existing logic)
  const rate_cents_per_min = record_enabled ? 2 : 1;

  // Bill ONLY overage minutes; minutes are rounded up
  let billed_cents = 0;

  if (duration_seconds != null && user_id) {
    const wholeMinutes = Math.max(1, Math.ceil(duration_seconds / 60));
    try {
      const account_id = await resolveAccountId(user_id);
      const { covered, remaining_to_bill } = await tryConsumeCallMinutes(account_id, wholeMinutes, new Date());
      const overage_minutes = Math.max(0, remaining_to_bill || 0);
      billed_cents = overage_minutes * rate_cents_per_min;
      log("usage.calls(minutes)", { wholeMinutes, covered, overage_minutes, billed_cents, rate_cents_per_min });
    } catch (e) {
      // usage hiccup → fall back to billing full minutes
      billed_cents = Math.max(1, Math.ceil(duration_seconds / 60)) * rate_cents_per_min;
      log("usage minutes error; fallback to full billing", e?.message);
    }
  } else if (duration_seconds != null) {
    billed_cents = Math.max(1, Math.ceil(duration_seconds / 60)) * rate_cents_per_min;
  }

  const baseUpdates = {
    status: failed ? "failed" : "completed",
    ended_at: endedISO,
  };
  if (duration_seconds !== null) baseUpdates.duration_seconds = duration_seconds;
  baseUpdates.billed_cents = billed_cents;
  if (failed) baseUpdates.error = hangup_cause;

  const { error: upErr } = await supa
    .from("call_logs")
    .update(baseUpdates)
    .eq("telnyx_leg_a_id", legA);

  if (upErr) {
    if (upErr.code === "42703" || /billed_cents/i.test(upErr.message || "")) {
      const { error: up2 } = await supa
        .from("call_logs")
        .update({
          status: baseUpdates.status,
          ended_at: baseUpdates.ended_at,
          duration_seconds: baseUpdates.duration_seconds,
          error: baseUpdates.error,
        })
        .eq("telnyx_leg_a_id", legA);
      if (up2) log("markEnded fallback err", up2.message);
    } else {
      log("markEnded err", upErr.message);
    }
  }

  // Wallet debit only for overage minutes
  if (billed_cents > 0 && row?.user_id) {
    const res = await debitWalletForCall({ legA, user_id: row.user_id, cents: billed_cents });
    if (!res.ok) log("wallet debit failed (non-fatal)", res.error || "unknown");
    else log("wallet debit ok", { user_id: row.user_id, billed_cents, record_enabled });
  }
}

/* ---------------- Handler ---------------- */
exports.handler = async (event) => {
  const rawBody = event.body || "";
  const sig =
    event.headers["telnyx-signature"] ||
    event.headers["telnyx-signature-ed25519"] ||
    event.headers["Telnyx-Signature"] ||
    event.headers["Telnyx-Signature-Ed25519"];

  if (!verifySignature(rawBody, sig)) {
    log("invalid signature");
    return { statusCode: 400, body: "Invalid signature" };
  }

  let payload;
  try { payload = JSON.parse(rawBody); }
  catch { log("json parse error"); return { statusCode: 200, body: "ok" }; }

  const data = payload?.data || {};
  const eventType = data?.event_type || data?.record_type;
  const p = data?.payload || data;
  const occurred_at = p?.occurred_at || payload?.occurred_at || new Date().toISOString();

  const legA = p?.call_control_id || p?.call_control_ids?.[0] || null;
  const call_session_id = p?.call_session_id || null;

  const peerLeg =
    p?.other_leg_id ||
    p?.peer_call_control_id ||
    p?.bridge_target_call_control_id ||
    null;

  const cs =
    decodeClientState(p?.client_state) ||
    decodeClientState(p?.client_state_b64) || {};

  const kind = cs.kind || null;
  const user_id = cs.user_id || cs.agent_id || null;
  const contact_id = cs.contact_id || null;
  const lead_number = cs.lead_number || p?.to || null;
  const from_number = cs.from_number || p?.from || null;
  const agent_number = cs.agent_number || null;
  const record_enabled = !!cs.record;
  const ringback_url = cs.ringback_url || null;

  log("event", eventType, {
    hasLegA: !!legA,
    kind,
    leadPrefix: lead_number ? String(lead_number).slice(0,4) + "…" : null,
    record_enabled
  });

  try {
    switch (eventType) {
      case "call.initiated": {
        if (legA && user_id && lead_number && from_number) {
          await upsertInitiated({
            user_id, contact_id,
            to_number: lead_number,
            from_number,
            agent_number,
            legA,
            call_session_id,
            started_at: occurred_at,
            record_enabled
          });
        }
        break;
      }

      case "call.answered": {
        // LEAD-FIRST: Lead answered → (optional) play ringback to the lead, then transfer to AGENT.
        if (ringback_url && legA) await playbackStart(legA, ringback_url);

        if (kind === "crm_outbound_lead_leg" && legA && agent_number && from_number) {
          await transferCall({ callControlId: legA, to: agent_number, from: from_number });
        }

        if (legA) await markAnswered({ legA, answered_at: occurred_at });
        break;
      }

      case "call.bridged": {
        // Stop ringback to the lead (now bridged), update status, start recording if enabled,
        // and mark the lead stage=answered (UI reflects without refresh).
        if (legA) await playbackStop(legA);
        await markBridged({ legA, maybeLegB: peerLeg || null });
        if (record_enabled && legA) startRecording(legA);
        if (contact_id) await markLeadAnsweredStage({ contact_id });
        break;
      }

      case "call.transfer.completed": {
        const outcome = (p?.result || p?.cause || p?.hangup_cause || "").toLowerCase();
        log("transfer.completed", { outcome, peerLeg: !!peerLeg });
        if (legA) await playbackStop(legA);
        const failed =
          !peerLeg ||
          ["busy", "no_answer", "call_rejected", "user_busy", "unallocated_number"].includes(outcome);
        if (failed && legA) {
          await hangupCall(legA);
        }
        break;
      }

      case "call.recording.saved": {
        const url = p?.recording_urls?.mp3 || p?.recording_url || null;
        if (call_session_id && url) {
          await saveRecordingUrlByCallSession({ call_session_id, recording_url: url });
        }
        break;
      }

      case "call.ended":
      case "call.hangup": {
        await playbackStop(legA);
        await markEnded({ legA, ended_at: occurred_at, hangup_cause: p?.hangup_cause });
        break;
      }

      case "call.transfer.initiated":
      case "call.initiated.outbound":
      case "call.answered.outbound": {
        if (legA && peerLeg) {
          await markBridged({ legA, maybeLegB: peerLeg });
        }
        break;
      }

      default:
        break;
    }
  } catch (e) {
    log("handler error", e?.message);
  }

  return { statusCode: 200, body: "ok" };
};
