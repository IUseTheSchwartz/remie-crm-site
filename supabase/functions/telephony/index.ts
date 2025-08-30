// supabase/functions/telephony/index.ts
Deno.serve((req) => {
  const url = new URL(req.url);
  if (url.pathname.endsWith("/status")) {
    return new Response(
      JSON.stringify({ status: "none", func: "telephony" }),
      { headers: { "content-type": "application/json" } }
    );
  }
  return new Response("Not found", { status: 404 });
});
