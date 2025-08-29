// File: src/lib/billing.js
import { supabase } from "../supabaseClient";

export async function startCheckout(priceId) {
  const { data: u } = await supabase.auth.getUser();
  const user = u?.user;
  if (!user?.email) {
    window.location.href = "/login";
    return;
  }

  const res = await fetch("/.netlify/functions/create-checkout-session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      priceId,
      email: user.email,
      userId: user.id,
      successUrl: window.location.origin + "/app/settings",
      cancelUrl: window.location.origin + "/",
    }),
  });
  const json = await res.json();
  if (json?.url) window.location.href = json.url;
  else alert("Could not start checkout");
}
