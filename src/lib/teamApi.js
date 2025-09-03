// Lightweight helpers for Team flows (Supabase + Netlify functions)

import { supabase } from "../lib/supabaseClient";

// Fetch the current user's id (string) or throw
export async function getCurrentUserId() {
  const { data, error } = await supabase.auth.getUser();
  if (error || !data?.user?.id) throw new Error("Not authenticated");
  return data.user.id;
}

// Call a Netlify function with X-User-Id header (owner/member actions)
export async function callFn(name, body = {}, method = "POST") {
  const userId = await getCurrentUserId();
  const res = await fetch(`/.netlify/functions/${name}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-User-Id": userId,
    },
    body: method === "GET" ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(msg || `Function ${name} failed`);
  }
  return res.json().catch(() => ({}));
}
