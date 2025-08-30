// supabase/functions/messaging/index.ts
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

// Env handling (local + production)
const SUPABASE_URL =
  Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321";

const SERVICE_ROLE =
  Deno.env.get("SERVICE_ROLE") ??
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  "";

const TWILIO_SID = Deno.env.get("TWILIO_ACCOUNT_SID") ?? "";
const TWILIO_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";

// Basic stub routes
serve(async (req) => {
  const url = new URL(req.url);

  if (url.pathname.endsWith("/status")) {
    return new Response(JSON.stringify({ status: "ok", func: "messaging" }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  if (url.pathname.endsWith("/conversations")) {
    return new Response(JSON.stringify([]), {
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response("Not found", { status: 404 });
});
