// File: netlify/functions/ten-dlc-assign.js
const { getServiceClient } = require("./_supabase");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  try {
    const authz = event.headers.authorization || event.headers.Authorization || "";
    const token = (authz.startsWith("Bearer ") ? authz.slice(7) : "").trim();
    if (!token) return json({ ok: false, error: "Missing auth token" }, 401);

    const supabase = getServiceClient();

    // Auth the user
    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user?.id) return json({ ok: false, error: "Auth failed" }, 401);
    const userId = userData.user.id;

    // If the user already has one, just return it
    {
      const { data: existing, error: exErr } = await supabase
        .from("ten_dlc_numbers")
        .select("phone_number, verified")
        .eq("assigned_to", userId)
        .maybeSingle();
      if (exErr) return json({ ok: false, error: exErr.message }, 500);
      if (existing) return json({ ok: true, phone_number: existing.phone_number, verified: !!existing.verified });
    }

    // Claim the oldest available verified number (status=active, verified=true, assigned_to is null)
    // Two-step claim with a safety check to avoid race conditions
    for (let i = 0; i < 3; i++) {
      const { data: candidate, error: selErr } = await supabase
        .from("ten_dlc_numbers")
        .select("id")
        .is("assigned_to", null)
        .eq("verified", true)
        .eq("status", "active")
        .order("date_assigned", { ascending: true, nullsFirst: true })
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();

      if (selErr) return json({ ok: false, error: selErr.message }, 500);
      if (!candidate) return json({ ok: false, error: "No verified numbers available" }, 409);

      // Try to atomically claim it: only succeed if still unassigned
      const { data: updated, error: updErr } = await supabase
        .from("ten_dlc_numbers")
        .update({ assigned_to: userId, date_assigned: new Date().toISOString() })
        .eq("id", candidate.id)
        .is("assigned_to", null)
        .select("phone_number, verified")
        .maybeSingle();

      if (updErr) return json({ ok: false, error: updErr.message }, 500);

      if (updated) {
        return json({ ok: true, phone_number: updated.phone_number, verified: !!updated.verified });
      }
      // else, someone else grabbed it; loop and try again
    }

    return json({ ok: false, error: "Failed to assign number" }, 500);
  } catch (e) {
    return json({ ok: false, error: e.message || "Server error" }, 500);
  }
};

function json(obj, statusCode = 200) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
