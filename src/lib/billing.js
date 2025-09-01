// File: src/lib/billing.js
import { supabase } from "../supabaseClient";

/** Keep your existing one for non-trial checkout */
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

/** Helper to read your plan price id from Vite env */
export function getPriceId() {
  const pid = import.meta.env.VITE_STRIPE_PRICE_ID;
  if (!pid) throw new Error("Missing VITE_STRIPE_PRICE_ID");
  return pid;
}

/** New: start a 14-day trial checkout */
export async function startTrialCheckout(priceId) {
  const { data: u } = await supabase.auth.getUser();
  const user = u?.user;
  if (!user?.email) {
    // preserve your redirect behavior
    window.location.href = "/login?next=start-trial";
    return;
  }

  const res = await fetch("/.netlify/functions/create-checkout-session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      priceId: priceId || getPriceId(),
      email: user.email,
      userId: user.id,
      trial: true, // << enable 14-day trial
      successUrl: window.location.origin + "/app/settings",
      cancelUrl: window.location.origin + "/",
    }),
  });

  const json = await res.json();
  if (json?.url) window.location.href = json.url;
  else alert("Could not start trial checkout");
}
