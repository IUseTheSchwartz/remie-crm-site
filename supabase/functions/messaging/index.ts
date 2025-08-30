// supabase/functions/messaging/index.ts
Deno.serve((_req) =>
  new Response(JSON.stringify({ ok: true, func: "messaging" }), {
    headers: { "content-type": "application/json" },
  })
);
