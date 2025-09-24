// File: src/lib/billing.js
import { supabase } from "./supabaseClient.js";

/** Non-trial checkout (kept from your original) */
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

/** Read your plan price id from Vite env */
export function getPriceId() {
  const pid = import.meta.env.VITE_STRIPE_PRICE_ID;
  if (!pid) throw new Error("Missing VITE_STRIPE_PRICE_ID");
  return pid;
}

/** 7-day trial checkout */
export async function startTrialCheckout(priceId) {
  const { data: u } = await supabase.auth.getUser();
  const user = u?.user;
  if (!user?.email) {
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
      trial: true,
      trialDays: 7, // ✅ tell the backend it's a 7-day trial
      successUrl: window.location.origin + "/app/settings",
      cancelUrl: window.location.origin + "/",
    }),
  });

  // Robust error handling to surface Stripe/Netlify text errors
  const contentType = res.headers.get("content-type") || "";
  if (!res.ok) {
    const text = await res.text();
    if (contentType.includes("application/json")) {
      try {
        const data = JSON.parse(text);
        throw new Error(data.error || data.message || text || "Checkout failed");
      } catch {
        throw new Error(text || "Checkout failed");
      }
    } else {
      throw new Error(text || "Checkout failed");
    }
  }

  const data = contentType.includes("application/json") ? await res.json() : {};
  if (data?.url) {
    window.location.href = data.url;
  } else {
    throw new Error("Missing checkout URL from server");
  }
}
