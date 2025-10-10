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
   Normalization + merge utils
----------------------------*/
const norm = (s) => (s == null ? "" : String(s).trim());
const normUpper = (s) => norm(s).toUpperCase();

function nonEmpty(v) {
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v.trim() !== "";
  return true;
}

/** Merge helper that prefers meaningful new values and never overwrites with empty/null */
function mergeKeep(base = {}, patch = {}) {
  const out = { ...base };
  for (const k of Object.keys(patch)) {
    const nv = patch[k];

    // nested object merge (sold, address, etc.)
    if (nv && typeof nv === "object" && !Array.isArray(nv)) {
      out[k] = mergeKeep(base[k] || {}, nv);
      continue;
    }

    if (!nonEmpty(nv)) continue; // skip empty/new nulls
    out[k] = nv;
  }
  return out;
}

/* ---------------------------
   Shape normalizer

   Person:
   {
     id: string,
     name: string,
     phone: string,
     email: string,
     status: "lead" | "sold",
     // pipeline
     stage?: string,
     stage_changed_at?: string,
     next_follow_up_at?: string,
     last_outcome?: string,
     call_attempts?: number,
     priority?: string|number,
     pipeline?: string,

     notes?: string,
     dob?: string,
     state?: string,
     beneficiary?: string,
     beneficiary_name?: string,
     company?: string,
     gender?: string,
     military_branch?: string,

     sold?: {
       carrier: string,
       faceAmount: string|number,
       premium: string|number,
       monthlyPayment: string|number,
       policyNumber?: string,
       // We support both for compatibility with older data / UI
       startDate?: string,
       effectiveDate?: string,
       notes?: string,
       address?: {
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

  const keep = {
    notes: norm(p.notes),
    dob: norm(p.dob),
    state: normUpper(p.state),
    beneficiary: norm(p.beneficiary),
    beneficiary_name: norm(p.beneficiary_name),
    company: norm(p.company),
    gender: norm(p.gender),
    military_branch: norm(p.military_branch),
    // pipeline fields (keep if provided)
    stage: p.stage ?? undefined,
    stage_changed_at: p.stage_changed_at ?? undefined,
    next_follow_up_at: p.next_follow_up_at ?? undefined,
    last_outcome: p.last_outcome ?? undefined,
    call_attempts: p.call_attempts ?? undefined,
    priority: p.priority ?? undefined,
    pipeline: p.pipeline ?? undefined,
  };

  // Prefer startDate (what the UI uses). If only effectiveDate exists (legacy),
  // keep it but also mirror to startDate so the UI can read it.
  const startDate = (sold && (sold.startDate || sold.effectiveDate)) || "";
  const effectiveDate = (sold && (sold.effectiveDate || sold.startDate)) || "";

  return {
    id:
      p.id ||
      (typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : String(Date.now())),
    name: norm(p.name),
    phone: p.phone || p.number || "",
    email: norm(p.email),
    status: p.status === "sold" ? "sold" : "lead",
    ...keep,
    sold: sold
      ? {
          carrier: norm(sold.carrier),
          faceAmount: sold.faceAmount ?? "",
          premium: sold.premium ?? "",
          monthlyPayment: sold.monthlyPayment ?? "",
          policyNumber: norm(sold.policyNumber),
          // keep both for compatibility
          startDate,
          effectiveDate,
          notes: norm(sold.notes),
          address: {
            street: norm(sold.address?.street),
            city: norm(sold.address?.city),
            state: normUpper(sold.address?.state),
            zip: norm(sold.address?.zip),
          },
        }
      : null,
  };
}

/* ---------------------------
   Upsert utility (merge by id)
----------------------------*/
export function upsert(arr = [], person = {}) {
  const incoming = normalizePerson(person);
  const idx = arr.findIndex((x) => x.id === incoming.id);

  if (idx === -1) {
    return [...arr, incoming];
  }

  const prev = arr[idx];

  // Merge top-level without clobbering with empties
  const mergedTop = mergeKeep(prev, incoming);

  // Merge sold (nested) carefully
  const mergedSold =
    incoming.sold == null
      ? prev.sold ?? null
      : mergeKeep(prev.sold || {}, incoming.sold);

  const next = { ...mergedTop, sold: mergedSold };

  const copy = [...arr];
  copy[idx] = next;
  return copy;
}

/* ---------------------------
   Merge array of persons
----------------------------*/
export function merge(arr = [], incoming = []) {
  let next = [...arr];
  for (const p of incoming) {
    next = upsert(next, p);
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
