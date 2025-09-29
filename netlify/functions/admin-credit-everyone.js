// netlify/functions/admin-credit-everyone.js
import { createClient } from "@supabase/supabase-js";

/** Read env in a way that works with your current names */
const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  process.env.VITE_SUPABASE_URL;

const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE ||           // ← your existing name
  process.env.SUPABASE_SERVICE_ROLE_KEY;         // (also accept _KEY if present)

const SUPABASE_ANON =
  process.env.SUPABASE_ANON_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY ||
  SUPABASE_SERVICE_ROLE_KEY; // fallback so user client can still auth.getUser()

function json(status, payload) {
  return { statusCode: status, body: JSON.stringify(payload) };
}

function toInt(n, def = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.trunc(v) : def;
}

function chunk(arr, size = 800) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export async function handler(event) {
  if (!SUPABASE_URL)  return json(500, { ok: false, error: "Missing SUPABASE_URL (or VITE_SUPABASE_URL)" });
  if (!SUPABASE_SERVICE_ROLE_KEY) return json(500, { ok: false, error: "Missing SUPABASE_SERVICE_ROLE (server env)" });

  if (event.httpMethod !== "POST") {
    return json(405, { ok: false, error: "Method Not Allowed" });
  }

  // Parse body
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}
  const amountCents = toInt(body.amount_cents ?? 0);
  const message = String(body.message ?? "");

  if (!(amountCents > 0)) {
    return json(400, { ok: false, error: "amount_cents must be a positive integer" });
  }

  // Build clients
  const bearer = (event.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON, {
    global: { headers: { Authorization: `Bearer ${bearer}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const service = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Identify caller
  const { data: userRes, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userRes?.user) {
    return json(401, { ok: false, error: "Unauthorized" });
  }
  const callerId = userRes.user.id;

  // Allowlist check (same concept as your hook)
  const { data: allow, error: allowErr } = await userClient
    .from("admin_allowlist")
    .select("user_id")
    .eq("user_id", callerId)
    .maybeSingle();

  if (allowErr) return json(500, { ok: false, error: `Allowlist check failed: ${allowErr.message}` });
  if (!allow)  return json(403, { ok: false, error: "Forbidden" });

  // Get the universe of users to credit (use agent_profiles as "everyone")
  const { data: agents, error: agentsErr } = await service
    .from("agent_profiles")
    .select("user_id");
  if (agentsErr) return json(500, { ok: false, error: agentsErr.message });

  const userIds = (agents || []).map(a => a.user_id).filter(Boolean);
  if (userIds.length === 0) return json(200, { ok: true, credited: 0, amount_cents: amountCents });

  // For each chunk, read existing wallet balances then upsert with the increment applied
  let credited = 0;
  for (const ids of chunk(userIds, 800)) {
    // Existing balances
    const { data: wallets, error: wErr } = await service
      .from("user_wallets")
      .select("user_id,balance_cents")
      .in("user_id", ids);

    if (wErr) return json(500, { ok: false, error: wErr.message });

    const current = new Map((wallets || []).map(w => [w.user_id, toInt(w.balance_cents, 0)]));

    const payload = ids.map(uid => ({
      user_id: uid,
      balance_cents: toInt((current.get(uid) || 0) + amountCents, amountCents),
    }));

    const { error: upErr } = await service
      .from("user_wallets")
      .upsert(payload, { onConflict: "user_id" });

    if (upErr) return json(500, { ok: false, error: upErr.message });

    credited += payload.length;
  }

  // Optionally log an admin event (no-op if you don't have the table)
  if (message) {
    await service.from("admin_events").insert({
      type: "wallet_mass_credit",
      meta: { amount_cents: amountCents, users: credited, message },
      created_by: callerId,
    }).catch(() => {});
  }

  return json(200, { ok: true, credited, amount_cents: amountCents });
}
