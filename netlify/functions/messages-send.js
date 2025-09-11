// File: netlify/functions/messages-send.js
import { createClient } from "@supabase/supabase-js";

// Use native fetch on Netlify runtime (no node-fetch import needed)

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE
);

const COST = parseInt(process.env.COST_PER_SEGMENT_CENTS || "1", 10);

function toE164(num) {
  const d = String(num || "").replace(/[^\d]/g, "");
  if (!d) return null;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  if (d.length === 10) return `+1${d}`;
  if (num.toString().startsWith("+")) return num.toString();
  return null;
}

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "Method Not Allowed" };
    }

    // ---- Auth (front end sends Supabase JWT) ----
    const auth = event.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return { statusCode: 401, body: "Missing auth" };

    const { data: { user }, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !user) return { statusCode: 401, body: "Invalid auth" };

    const { to, body, contact_id } = JSON.parse(event.body || "{}");

    const toE = toE164(to);
    if (!toE || !body) {
      return { statusCode: 400, body: "Bad request: to (E.164) and body required" };
    }

    // ---- Wallet check ----
    const { data: wallet } = await supabase
      .from("user_wallets")
      .select("balance_cents")
      .eq("user_id", user.id)
      .maybeSingle();

    if (!wallet || wallet.balance_cents < COST) {
      return { statusCode: 402, body: "Insufficient balance" };
    }

    // Deduct (very simple; if you want atomicity, use RPC/row level lock)
    await supabase
      .from("user_wallets")
      .update({ balance_cents: wallet.balance_cents - COST })
      .eq("user_id", user.id);

    // ---- Send via Telnyx ----
    const payload = {
      from: process.env.TELNYX_FROM,                       // must be your TFN in E.164
      to: toE,                                             // E.164
      text: body,
      messaging_profile_id: process.env.TELNYX_MESSAGING_PROFILE
    };

    // Quick env sanity (helps catch empty envs)
    if (!process.env.TELNYX_API_KEY) {
      return { statusCode: 500, body: "Missing TELNYX_API_KEY env" };
    }
    if (!process.env.TELNYX_FROM) {
      return { statusCode: 500, body: "Missing TELNYX_FROM env" };
    }
    if (!process.env.TELNYX_MESSAGING_PROFILE) {
      return { statusCode: 500, body: "Missing TELNYX_MESSAGING_PROFILE env" };
    }

    const apiRes = await fetch("https://api.telnyx.com/v2/messages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.TELNYX_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const apiJson = await apiRes.json().catch(() => ({}));

    if (!apiRes.ok) {
      // Log full Telnyx error so we can see the code/message in Netlify logs
      console.error("[Telnyx error]", apiRes.status, JSON.stringify(apiJson));
      // Return it to the frontend to make debugging easier
      return {
        statusCode: 502,
        body: JSON.stringify({ message: "Telnyx send failed", status: apiRes.status, telnyx: apiJson }),
      };
    }

    const telnyxId = apiJson?.data?.id || apiJson?.id || null;

    // ---- Persist message ----
    await supabase.from("messages").insert({
      user_id: user.id,
      contact_id: contact_id || null,
      provider: "telnyx",
      direction: "out",
      from_number: process.env.TELNYX_FROM,
      to_number: toE,
      body,
      status: "queued",
      provider_sid: telnyxId,
      segments: 1,
      price_cents: COST,
    });

    return { statusCode: 200, body: JSON.stringify({ ok: true, id: telnyxId }) };
  } catch (e) {
    console.error("[messages-send fatal]", e);
    return { statusCode: 500, body: "Send failed" };
  }
}
