// File: src/lib/wallet.js
import { supabase } from "./supabaseClient";

export async function getMyBalanceCents() {
  const { data: auth } = await supabase.auth.getUser();
  const uid = auth?.user?.id;
  if (!uid) return 0;
  const { data } = await supabase
    .from("user_wallets")
    .select("balance_cents")
    .eq("user_id", uid)
    .maybeSingle();
  return data?.balance_cents ?? 0;
}

export function formatUSD(cents) {
  const n = Math.max(0, parseInt(cents || 0, 10));
  return `$${(n / 100).toFixed(2)}`;
}
