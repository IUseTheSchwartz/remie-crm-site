// Replace ONLY the startTrialCheckout function with this version:
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
      successUrl: window.location.origin + "/app/settings",
      cancelUrl: window.location.origin + "/",
    }),
  });

  // Robust error handling: if server didn't return JSON, show the raw text
  const contentType = res.headers.get("content-type") || "";
  if (!res.ok) {
    const text = await res.text();
    // If server returned JSON, try to parse it for cleaner message
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

  // OK response:
  const data = contentType.includes("application/json") ? await res.json() : {};
  if (data?.url) {
    window.location.href = data.url;
  } else {
    throw new Error("Missing checkout URL from server");
  }
}
