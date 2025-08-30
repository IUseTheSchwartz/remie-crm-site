import { getUserFromRequest, getServiceClient } from "./_supabase.js";

export default async (req) => {
  const user = await getUserFromRequest(req);
  if (!user) return new Response("Unauthorized", { status: 401 });

  const supa = getServiceClient();
  const { error } = await supa.from("calendly_tokens").delete().eq("user_id", user.id);
  if (error) return new Response(error.message, { status: 500 });

  return new Response(JSON.stringify({ ok: true }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
};
