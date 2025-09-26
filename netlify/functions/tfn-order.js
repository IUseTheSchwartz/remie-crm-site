// File: netlify/functions/tfn-order.js
// Orders a toll-free number from Telnyx and records it to agent_messaging_numbers.
// Then tries to assign your messaging profile (with retries), but insert happens regardless.

const fetch = require("node-fetch");
const { getServiceClient, getUserFromRequest } = require("./_supabase");

function json(body, status = 200) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function S(x) { return x == null ? "" : String(x); }
function toE164(p) {
  const d = String(p || "").replace(/\D/g, "");
  if (!d) return null;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  if (d.length === 10) return `+1${d}`;
  return S(p).startsWith("+") ? S(p) : null;
}

async function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return json({ error: "Method Not Allowed" }, 405);

    const API_KEY = process.env.TELNYX_API_KEY;
    const PROFILE_ID = process.env.TELNYX_MESSAGING_PROFILE_ID || null;
    if (!API_KEY) return json({ error: "TELNYX_API_KEY missing" }, 500);

    // Identify user (prefer Authorization: Bearer <supabase_access_token>)
    const authedUser = await getUserFromRequest(event);
    let user_id = authedUser?.id || null;

    let body = {};
    try { body = JSON.parse(event.body || "{}"); } catch {}
    // allow explicit override (e.g., from server-side admin tools)
    user_id = body.user_id || user_id;

    const telnyx_phone_id = S(body.telnyx_phone_id).trim();
    const e164_in = toE164(body.e164);
    if (!user_id)        return json({ error: "auth_required" }, 401);
    if (!telnyx_phone_id) return json({ error: "missing_params", need: ["telnyx_phone_id"] }, 400);
    if (!e164_in)         return json({ error: "invalid_e164" }, 400);

    const db = getServiceClient();

    // 1) Order the number (if not already owned). We call the Phone Number Orders API.
    // NOTE: If the number is already in your account, Telnyx will usually return 422/409; we still proceed to insert.
    let ordered = null;
    try {
      const orderRes = await fetch("https://api.telnyx.com/v2/number_orders", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          phone_numbers: [{ phone_number: e164_in }],
        }),
      });
      const orderJson = await orderRes.json().catch(() => ({}));
      if (!orderRes.ok) {
        // Don’t block insert; just report the order failure back
        ordered = { ok: false, status: orderRes.status, payload: orderJson };
      } else {
        ordered = { ok: true, payload: orderJson };
      }
    } catch (e) {
      ordered = { ok: false, error: String(e?.message || e) };
    }

    // 2) Insert or upsert into agent_messaging_numbers (always do this)
    let inserted = null;
    try {
      const up = await db
        .from("agent_messaging_numbers")
        .upsert({
          user_id,
          e164: e164_in,
          telnyx_phone_id,
          telnyx_messaging_profile_id: PROFILE_ID || null,
          status: "active", // we mark active once selected
          verified_at: null,
        }, { onConflict: "e164" })
        .select("id, user_id, e164, status")
        .maybeSingle();

      if (up?.error) throw up.error;
      inserted = { ok: true, row: up?.data || null };
    } catch (e) {
      return json({ error: "db_insert_failed", detail: String(e?.message || e) }, 500);
    }

    // 3) Try to assign the messaging profile (retry a few times; don’t fail the whole call if this fails)
    let assignResult = { attempted: false, ok: false };
    if (PROFILE_ID) {
      assignResult.attempted = true;

      const maxTries = 4;
      let attempt = 0;
      let lastErr = null;

      while (attempt < maxTries) {
        attempt += 1;
        try {
          const patch = await fetch(`https://api.telnyx.com/v2/phone_numbers/${encodeURIComponent(telnyx_phone_id)}`, {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ messaging_profile_id: PROFILE_ID }),
          });
          const j = await patch.json().catch(() => ({}));
          if (patch.ok) {
            assignResult.ok = true;
            assignResult.status = patch.status;
            assignResult.payload = j;
            break;
          }
          lastErr = { status: patch.status, payload: j };
        } catch (e) {
          lastErr = { error: String(e?.message || e) };
        }
        // exponential-ish backoff: 0.8s, 1.5s, 2.5s…
        await sleep(800 * attempt + 200);
      }

      if (!assignResult.ok) {
        assignResult.error = lastErr || { reason: "unknown" };
      }
    }

    return json({
      ok: true,
      user_id,
      e164: e164_in,
      telnyx_phone_id,
      ordered,
      inserted,
      assign: assignResult,
      note: assignResult.ok
        ? "Number saved and profile assigned."
        : "Number saved. Profile assignment will need a manual attach in Telnyx if it didn’t stick.",
    });
  } catch (e) {
    return json({ error: "unhandled", detail: String(e?.message || e) }, 500);
  }
};
