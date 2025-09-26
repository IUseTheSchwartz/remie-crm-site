// File: netlify/functions/telnyx-list-my-numbers.js
const fetch = require("node-fetch");
const { getServiceClient } = require("./_supabase");

exports.handler = async (event) => {
  try {
    const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
    if (!TELNYX_API_KEY) {
      return { statusCode: 500, body: JSON.stringify({ error: "Missing TELNYX_API_KEY" }) };
    }

    const includeMine = (event.queryStringParameters && event.queryStringParameters.include_mine) === "1";
    const userId = event.queryStringParameters && event.queryStringParameters.user_id;

    // 1) Get all toll-free numbers you OWN from Telnyx
    const url = "https://api.telnyx.com/v2/phone_numbers?per_page=200";
    const r = await fetch(url, { headers: { Authorization: `Bearer ${TELNYX_API_KEY}` } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      return { statusCode: r.status, body: JSON.stringify(j) };
    }

    const allTollFree = (j.data || [])
      .filter((p) => p.phone_number_type === "toll_free")
      .map((p) => ({
        id: p.id,
        e164: p.phone_number,
        messaging_profile_id: p.messaging_profile_id || null,
        status: p.status || "active",
        purchased_at: p.purchased_at || null,
      }));

    // 2) Pull all ACTIVE assignments from DB and exclude them
    const db = getServiceClient();
    const { data: assigned, error: aErr } = await db
      .from("agent_messaging_numbers")
      .select("user_id, e164, status")
      .eq("status", "active");

    if (aErr) {
      return { statusCode: 500, body: JSON.stringify({ error: aErr.message }) };
    }

    const assignedSet = new Set((assigned || []).map((x) => (x.e164 || "").trim()));

    let filtered = allTollFree.filter((n) => !assignedSet.has((n.e164 || "").trim()));

    // Optionally: include the caller's own number if they want to display it
    if (includeMine && userId) {
      const mineRows = (assigned || []).filter((x) => x.user_id === userId && x.status === "active");
      const mineSet = new Set(mineRows.map((x) => (x.e164 || "").trim()));
      const mine = allTollFree.filter((n) => mineSet.has((n.e164 || "").trim()));
      // Put "mine" at the top with a flag
      filtered = [
        ...mine.map((m) => ({ ...m, _isMine: true })),
        ...filtered
      ];
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, numbers: filtered }),
      headers: { "Content-Type": "application/json" },
    };
  } catch (e) {
    console.error(e);
    return { statusCode: 500, body: JSON.stringify({ error: e.message || String(e) }) };
  }
};