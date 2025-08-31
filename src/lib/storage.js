// File: src/lib/storage.js

// LocalStorage keys (swap to Supabase later)
const KEYS = {
  leads: "remie_leads_v1",     // raw leads / prospects
  clients: "remie_clients_v1", // unified list (leads + sold)
};

/* ---------------------------
   Basic load/save helpers
----------------------------*/
export function loadLeads() {
  try {
    return JSON.parse(localStorage.getItem(KEYS.leads)) || [];
  } catch {
    return [];
  }
}
export function saveLeads(leads) {
  localStorage.setItem(KEYS.leads, JSON.stringify(leads));
}

export function loadClients() {
  try {
    return JSON.parse(localStorage.getItem(KEYS.clients)) || [];
  } catch {
    return [];
  }
}
export function saveClients(clients) {
  localStorage.setItem(KEYS.clients, JSON.stringify(clients));
}

/* ---------------------------
   Shape normalizer

   Person (stored locally):
   {
     id: string,
     name: string,
     phone: string,
     email: string,
     status: 'lead' | 'sold',

     // NEW optional lead fields
     notes?: string,
     dob?: string,                 // freeform date from CSV
     state?: string,               // e.g., "TX"
     beneficiary?: string,         // e.g., "Primary"
     beneficiary_name?: string,    // e.g., "John Doe"
     gender?: string,              // e.g., "Male"

     sold: {
       carrier: string,
       faceAmount: string|number,
       premium: string|number,
       monthlyPayment: string|number,
       startDate: string (YYYY-MM-DD),
       name: string,
       phone: string,
       email: string,
       address: {
         street: string,
         city: string,
         state: string,
         zip: string,
       }
     } | null
   }
----------------------------*/
export function normalizePerson(p = {}) {
  const sold = p.sold || null;

  // Allow/keep extra lead fields if present
  const keep = {
    notes: p.notes ?? "",
    dob: p.dob ?? "",
    state: p.state ?? "",
    beneficiary: p.beneficiary ?? "",
    beneficiary_name: p.beneficiary_name ?? "",
    gender: p.gender ?? "",
  };

  return {
    id: p.id || (typeof crypto !== "undefined" ? crypto.randomUUID() : String(Date.now())),
    name: p.name || "",
    phone: p.phone || p.number || "",
    email: p.email || "",
    status: p.status === "sold" ? "sold" : "lead",
    ...keep,
    sold: sold
      ? {
          carrier: sold.carrier || "",
          faceAmount: sold.faceAmount || "",
          premium: sold.premium || "",
          monthlyPayment: sold.monthlyPayment || "",
          startDate: sold.startDate || "",
          name: sold.name || p.name || "",
          phone: sold.phone || p.phone || "",
          email: sold.email || p.email || "",
          address: {
            street: sold.address?.street || "",
            city: sold.address?.city || "",
            state: sold.address?.state || "",
            zip: sold.address?.zip || "",
          },
        }
      : null,
  };
}

/* ---------------------------
   Array upsert by id

   - Normalizes incoming
   - If an existing record has a non-null `sold` and the
     incoming one is `null`/missing, we preserve the existing `sold`.
----------------------------*/
export function upsert(arr = [], obj = {}) {
  const incoming = normalizePerson(obj);
  const next = [...arr];
  const i = next.findIndex((x) => x.id === incoming.id);

  if (i >= 0) {
    const existing = next[i];

    // Prefer incoming.sold only if provided (non-null)
    const mergedSold =
      incoming.sold != null ? incoming.sold : existing.sold ?? null;

    // Merge everything else (incoming primitives will override)
    next[i] = {
      ...existing,
      ...incoming,
      sold: mergedSold,
    };
  } else {
    next.unshift(incoming);
  }
  return next;
}

/* ---------------------------
   Optional utilities
----------------------------*/
export function removeById(arr = [], id) {
  return arr.filter((x) => x.id !== id);
}

export function clearAllLocal() {
  localStorage.removeItem(KEYS.leads);
  localStorage.removeItem(KEYS.clients);
}
