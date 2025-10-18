// netlify/functions/track-dial.js
const { getServiceClient, getUserFromRequest } = require("./_supabase");

/** YYYY-MM-DD string for "now" in a given IANA timezone */
function ymdInTZ(tz) {
  // Build parts in the target TZ to avoid UTC/offset issues
  const d = new Date();
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  // en-CA gives YYYY-MM-DD directly
  return fmt.format(d); // e.g. "2025-10-18"
}

function json(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  try {
    const db = getServiceClient();

    // ---- figure out tz (from query ?tz=..., or POST body.tz, fallback CST)
    let tz =
      new URLSearchParams(event.queryStringParameters || {}).get("tz") ||
      (event.httpMethod !== "GET"
        ? (() => {
            try {
              const b = JSON.parse(event.body || "{}");
              return b.tz;
            } catch {
              return null;
            }
          })()
        : null) ||
      "America/Chicago"; // sensible default

    // ---- Auth: header bearer OR body.jwt (same behavior as before)
    let user = await getUserFromRequest(event);
    if (!user) {
      if (event.httpMethod !== "GET") {
        try {
          const body = JSON.parse(event.body || "{}");
          if (body?.jwt) {
            const { data, error } = await db.auth.getUser(body.jwt);
            if (!error) user = data?.user || null;
          }
        } catch {}
      }
    }

    if (!user?.id) {
      if (event.httpMethod === "GET") {
        return json(200, { ok: true, count: 0, unauthenticated: true, tz });
      }
      return json(401, { ok: false, error: "unauthorized" });
    }

    const today = ymdInTZ(tz); // YYYY-MM-DD in the chosen timezone

    if (event.httpMethod === "GET") {
      // Read today’s aggregate count
      const { data, error } = await db
        .from("dial_counts")
        .select("count")
        .eq("user_id", user.id)
        .eq("tz", tz)
        .eq("day", today)
        .maybeSingle();

      if (error && error.code !== "PGRST116") { // not-found is fine
        return json(500, { ok: false, error: error.message });
      }
      return json(200, { ok: true, count: data?.count ?? 0, tz, day: today });
    }

    if (event.httpMethod === "POST") {
      // Optional payload fields we still accept (not used by dial_counts)
      let body = {};
      try { body = JSON.parse(event.body || "{}"); } catch {}

      // 1) Try UPDATE to increment count if row exists
      const { data: updData, error: updErr } = await db
        .from("dial_counts")
        .update({ // can't do count = count + 1 directly via client, so:
          // We'll set a placeholder; the real increment happens by re-read + upsert below.
          // This UPDATE only serves to detect existence quickly; we'll ignore its values.
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", user.id)
        .eq("tz", tz)
        .eq("day", today)
        .select("count") // returns row if exists
        .maybeSingle();

      if (updErr && updErr.code !== "PGRST116") {
        // unexpected error
        return json(500, { ok: false, error: updErr.message });
      }

      if (updData) {
        // Row exists -> re-read count and write back +1 (simple, fine for single clicks)
        const current = updData.count ?? 0;
        const { data: up2, error: up2err } = await db
          .from("dial_counts")
          .update({ count: current + 1, updated_at: new Date().toISOString() })
          .eq("user_id", user.id)
          .eq("tz", tz)
          .eq("day", today)
          .select("count")
          .single();
        if (up2err) return json(500, { ok: false, error: up2err.message });
        return json(200, { ok: true, count: up2.count, tz, day: today });
      }

      // 2) Row didn’t exist -> try INSERT count=1
      const { data: ins, error: insErr } = await db
        .from("dial_counts")
        .insert([{ user_id: user.id, tz, day: today, count: 1 }])
        .select("count")
        .single();

      if (!insErr) {
        return json(200, { ok: true, count: ins.count, tz, day: today });
      }

      // 3) If we hit a race (conflict), fall back to a final UPDATE +1
      if (insErr && String(insErr.message || "").toLowerCase().includes("duplicate")) {
        const { data: rd, error: rdErr } = await db
          .from("dial_counts")
          .select("count")
          .eq("user_id", user.id)
          .eq("tz", tz)
          .eq("day", today)
          .single();
        if (rdErr) return json(500, { ok: false, error: rdErr.message });
        const { data: up3, error: up3err } = await db
          .from("dial_counts")
          .update({ count: (rd?.count ?? 0) + 1, updated_at: new Date().toISOString() })
          .eq("user_id", user.id)
          .eq("tz", tz)
          .eq("day", today)
          .select("count")
          .single();
        if (up3err) return json(500, { ok: false, error: up3err.message });
        return json(200, { ok: true, count: up3.count, tz, day: today });
      }

      // unexpected insert error
      return json(500, { ok: false, error: insErr.message });
    }

    return json(405, { ok: false, error: "method_not_allowed" });
  } catch (e) {
    console.error("[track-dial] unhandled:", e);
    return json(500, { ok: false, error: "server_error" });
  }
};
