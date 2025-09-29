// netlify/functions/admin-credit-everyone.js
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const anon = process.env.SUPABASE_ANON_KEY;
const service = process.env.SUPABASE_SERVICE_ROLE_KEY;

export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  try {
    const { amountUsd } = JSON.parse(event.body || "{}");
    const amount = Number(String(amountUsd).replace(/[^0-9.]/g, ""));
    if (!Number.isFinite(amount) || amount <= 0) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: "Invalid amount" }) };
    }
    const amountCents = Math.round(amount * 100);

    // Verify requester (must be logged in + on admin allowlist)
    const token = event.headers.authorization?.replace(/^Bearer\s+/i, "") || "";
    const userScoped = createClient(url, anon, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userRes } = await userScoped.auth.getUser();
    const userId = userRes?.user?.id;
    if (!userId) return { statusCode: 401, body: JSON.stringify({ ok: false, error: "Unauthorized" }) };

    // Service client (elevated)
    const serviceClient = createClient(url, service, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Check allowlist (table: admin_allowlist with pk user_id)
    const { data: allow, error: allowErr } = await serviceClient
      .from("admin_allowlist")
      .select("user_id")
      .eq("user_id", userId)
      .maybeSingle();
    if (allowErr) throw allowErr;
    if (!allow) return { statusCode: 403, body: JSON.stringify({ ok: false, error: "Forbidden" }) };

    // Load all user_ids from agent_profiles
    const { data: profiles, error: pErr } = await serviceClient
      .from("agent_profiles")
      .select("user_id");
    if (pErr) throw pErr;

    const allUserIds = (profiles || []).map((p) => p.user_id).filter(Boolean);
    if (allUserIds.length === 0) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, affected: 0, amount_cents: amountCents }) };
    }

    // Fetch existing wallets
    const { data: wallets, error: wErr } = await serviceClient
      .from("user_wallets")
      .select("user_id, balance_cents");
    if (wErr) throw wErr;

    const have = new Set((wallets || []).map((w) => w.user_id));
    const missing = allUserIds.filter((id) => !have.has(id));

    // Ensure missing wallets exist
    if (missing.length) {
      const payload = missing.map((user_id) => ({ user_id, balance_cents: 0 }));
      for (let i = 0; i < payload.length; i += 500) {
        const chunk = payload.slice(i, i + 500);
        const { error } = await serviceClient
          .from("user_wallets")
          .upsert(chunk, { onConflict: "user_id" });
        if (error) throw error;
      }
    }

    // Build current balances map
    const byUser = new Map();
    (wallets || []).forEach((w) => byUser.set(w.user_id, Number(w.balance_cents || 0)));
    missing.forEach((id) => byUser.set(id, 0));

    // Increment everyone
    const updates = allUserIds.map((id) => ({
      user_id: id,
      balance_cents: (byUser.get(id) || 0) + amountCents,
    }));

    for (let i = 0; i < updates.length; i += 500) {
      const chunk = updates.slice(i, i + 500);
      const { error } = await serviceClient
        .from("user_wallets")
        .upsert(chunk, { onConflict: "user_id" });
      if (error) throw error;
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, affected: allUserIds.length, amount_cents: amountCents }),
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: e.message || "Server error" }) };
  }
}
