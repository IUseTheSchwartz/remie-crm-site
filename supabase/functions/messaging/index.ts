// supabase/functions/messaging/index.ts
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

serve(async (req) => {
  const url = new URL(req.url);

  if (url.pathname === "/status") {
    return new Response(JSON.stringify({ status: "ok" }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  if (url.pathname === "/conversations") {
    return new Response(JSON.stringify([]), {
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response("Not found", { status: 404 });
});
