import { useState } from "react";
import Papa from "papaparse";
import { supabase } from "../../lib/supabaseClient.js";
import { toE164 } from "../../lib/phone.js";
import { normalizePerson } from "../../lib/storage.js";
import { upsertManyLeadsServer } from "../../lib/supabaseLeads.js";

const FN_BASE = import.meta.env?.VITE_FUNCTIONS_BASE || "/.netlify/functions";

/* -------------------- CSV helpers -------------------- */
function stripBOM(s){return String(s||"").replace(/^\uFEFF/,"")}
const norm=(s)=>stripBOM(s).trim().toLowerCase();
function cleanEmail(e){const v=stripBOM(String(e||"").trim().toLowerCase()); if(!v) return ""; const junk=new Set(["n/a","na","none","-","null","unknown","noemail","no email"]); return junk.has(v)?"":v;}
function canonicalDigits(s){const d=String(s||"").replace(/\D+/g,""); return d?d.slice(-10):"";}
const onlyDigits=(s)=>String(s||"").replace(/\D+/g,"");

const H = {
  first:["first","first name","firstname","given name","given_name","fname","first_name"],
  last:["last","last name","lastname","surname","family name","lname","last_name","family_name"],
  full:["name","full name","fullname","full_name"],
  email:["email","e-mail","email address","mail","email_address"],
  phone:["phone","phone number","mobile","cell","tel","telephone","number","phone_number"],
  notes:["notes","note","comments","comment","details"],
  company:["company","business","organization","organisation"],
  dob:["dob","date of birth","birthdate","birth date","d.o.b.","date"],
  state:["state","st","us state","residence state"],
  beneficiary:["beneficiary","beneficiary type"],
  beneficiary_name:["beneficiary name","beneficiary_name","beneficiary full name"],
  gender:["gender","sex"],
  military_branch:["military","military branch","branch","service branch","military_branch","branch_of_service"],
};
function buildHeaderIndex(headers){
  const normalized=headers.map(norm);
  const matches=(nh,cand)=>{
    if((nh||"").startsWith("unnamed")) return false;
    const c=cand.toLowerCase();
    if(nh===c) return true;
    if(nh===c.replace(/_/g," ")) return true;
    if(c==="military") return nh==="military"||nh.includes("branch");
    if(nh.includes("branch")&&c.includes("branch")) return true;
    if(nh.includes(c)&&c.length>3) return true;
    return false;
  };
  const find=(cands)=>{
    for(let i=0;i<normalized.length;i++){ for(const cand of cands){ if(normalized[i]===cand) return headers[i];}}
    for(let i=0;i<normalized.length;i++){ if(normalized[i].includes("branch")){ for(const cand of cands){ if(matches(normalized[i],cand)) return headers[i];}}}
    for(let i=0;i<normalized.length;i++){ for(const cand of cands){ if(matches(normalized[i],cand)) return headers[i];}}
    return null;
  };
  return {
    first:find(H.first), last:find(H.last), full:find(H.full), email:find(H.email), phone:find(H.phone),
    notes:find(H.notes), company:find(H.company), dob:find(H.dob), state:find(H.state),
    beneficiary:find(H.beneficiary), beneficiary_name:find(H.beneficiary_name), gender:find(H.gender),
    military_branch:find(H.military_branch),
  };
}
const pick=(row,key)=> key ? (row[key]==null ? "" : String(row[key]).trim()) : "";
function buildName(row,map){
  const combined=`${pick(row,map.first)} ${pick(row,map.last)}`.replace(/\s+/g," ").trim();
  if(combined) return combined;
  const full=pick(row,map.full); if(full) return full;
  const company=pick(row,map.company); if(company) return company;
  const email=pick(row,map.email); if(email&&email.includes("@")) return email.split("@")[0];
  return "";
}
const buildPhone=(row,map)=> pick(row,map.phone) || row.phone || row.number || row.Phone || row.Number || "";
const buildEmail=(row,map)=> pick(row,map.email) || row.email || row.Email || "";
const buildNotes=(row,map)=> pick(row,map.notes) || "";
const buildDob=(row,map)=> pick(row,map.dob);
const buildState=(row,map)=> (pick(row,map.state) || "").toUpperCase();
const buildBeneficiary=(row,map)=> pick(row,map.beneficiary);
const buildBeneficiaryName=(row,map)=> pick(row,map.beneficiary_name);
const buildGender=(row,map)=> pick(row,map.gender);
const buildMilitaryBranch=(row,map)=> pick(row,map.military_branch);

/* -------------------- Preview helper -------------------- */
function estimateSegments(text=""){
  const s=String(text);
  const gsm7=/^[\n\r\t\0\x0B\x0C\x1B\x20-\x7E€£¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ^{}\[\]~|€\\]*$/.test(s);
  return gsm7 ? (s.length<=160?1:Math.ceil(s.length/153)) : (s.length<=70?1:Math.ceil(s.length/67));
}

/* -------------------- Contacts (only on Add & Message Now) -------------------- */
async function findContactByDigits(userId, digits){
  const { data, error } = await supabase
    .from("message_contacts").select("id,phone,tags").eq("user_id", userId);
  if (error) throw error;
  return (data||[]).find(c=>onlyDigits(c.phone)===digits)||null;
}
async function upsertContactForPerson(userId, person){
  const e164 = toE164(person.phone);
  if(!e164) return null;
  const digits = onlyDigits(e164);
  const existing = await findContactByDigits(userId, digits);
  const statusTag = "lead";
  if(existing?.id){
    const cur = Array.isArray(existing.tags)?existing.tags:[];
    const without = cur.filter(t=>!["lead","military"].includes(String(t).toLowerCase()));
    const tags = Array.from(new Set([...without,statusTag]));
    await supabase.from("message_contacts")
      .update({ phone:e164, full_name:person.name||null, subscribed:true, tags })
      .eq("id", existing.id);
    return existing.id;
  }else{
    const { data, error } = await supabase.from("message_contacts")
      .insert([{ user_id:userId, phone:e164, full_name:person.name||null, subscribed:true, tags:[statusTag] }])
      .select("id").single();
    if(error) throw error;
    return data?.id||null;
  }
}
async function ensureContactsForPeople(people){
  const { data: auth } = await supabase.auth.getUser();
  const userId = auth?.user?.id;
  if(!userId) return;
  for(const p of people){ if(p.phone) { try{ await upsertContactForPerson(userId,p); }catch{} } }
}

/* -------------------- Component -------------------- */
export default function CsvImportControl({ onAddedLocal, onServerMsg }) {
  const [choice,setChoice]=useState(null);
  const [confirm,setConfirm]=useState(null);
  const [isSending,setIsSending]=useState(false);
  const msg=(s)=>onServerMsg?.(s);

  async function handleImportCsv(file){
    Papa.parse(file,{
      header:true, skipEmptyLines:true,
      transformHeader:(h)=>stripBOM(h).trim(),
      complete: async (res)=>{
        const rows=res.data||[];
        if(!rows.length){ alert("CSV has no rows."); return; }

        // local de-dupe
        let existing=[]; try{
          const leads=JSON.parse(localStorage.getItem("remie_leads")||"[]");
          const clients=JSON.parse(localStorage.getItem("remie_clients")||"[]");
          existing=[...leads,...clients];
        }catch{}

        const headers=Object.keys(rows[0]||{});
        const map=buildHeaderIndex(headers);

        const existingEmails=new Set(existing.map(r=>cleanEmail(r.email)).filter(Boolean));
        const existingPhones=new Set(existing.map(r=>canonicalDigits(r.phone)).filter(Boolean));
        const seenEmails=new Set(); const seenPhones=new Set();

        const uniqueToAdd=[]; let skippedDupEmail=0,skippedDupPhone=0,skippedEmpty=0;
        for(const r of rows){
          const person=normalizePerson({
            name: buildName(r,map) || r.name || r.Name || "",
            phone: buildPhone(r,map),
            email: buildEmail(r,map),
            notes: buildNotes(r,map),
            stage: "no_pickup",
            dob: buildDob(r,map),
            state: buildState(r,map),
            beneficiary: buildBeneficiary(r,map),
            beneficiary_name: buildBeneficiaryName(r,map),
            gender: buildGender(r,map),
            military_branch: buildMilitaryBranch(r,map),
          });
          const e164 = toE164(person.phone);
          if(e164) person.phone = e164;
          person.email = (person.email||"").trim().toLowerCase();

          const e=cleanEmail(person.email);
          const p=canonicalDigits(person.phone);
          if(!(person.name||e||p)){ skippedEmpty++; continue; }

          const emailDup = e && (existingEmails.has(e)||seenEmails.has(e));
          const phoneDup = p && (existingPhones.has(p)||seenPhones.has(p));
          if(emailDup||phoneDup){ if(emailDup) skippedDupEmail++; if(phoneDup) skippedDupPhone++; continue; }

          if(e) seenEmails.add(e); if(p) seenPhones.add(p);
          uniqueToAdd.push(person);
        }

        if(!uniqueToAdd.length){
          const parts=[]; if(skippedDupEmail) parts.push(`${skippedDupEmail} email dupes`);
          if(skippedDupPhone) parts.push(`${skippedDupPhone} phone dupes`);
          if(skippedEmpty) parts.push(`${skippedEmpty} empty rows`);
          msg(`No new leads found in CSV${parts.length?` (${parts.join(", ")})`:""}.`);
          return;
        }

        setChoice({ count: uniqueToAdd.length, people: uniqueToAdd });
      },
      error:(err)=>alert("CSV parse error: "+err.message),
    });
  }

  async function persist(valid){
    onAddedLocal?.(valid);
    try{
      msg(`Syncing ${valid.length} lead(s) to Supabase…`);
      const wrote = await upsertManyLeadsServer(valid);
      msg(`✅ CSV synced (${wrote} saved)`);
    }catch(e){
      console.error(e); msg(`⚠️ CSV sync failed: ${e.message||e}`);
    }
  }

  async function previewSend(valid){
    const total = valid.filter(v=>!!toE164(v.phone)).length;
    const est_segments = valid.reduce((n,v)=>n+estimateSegments(""),0);
    return {
      total_candidates: valid.length,
      will_send: total,
      estimated_segments: est_segments,
      batch_id: Math.random().toString(36).slice(2,10),
      skipped_by_reason: {},
    };
  }

  // NEW: fetch freshly-inserted lead IDs by phone (with tiny retry)
  async function mapLeadIdsByPhone(phonesE164, userId){
    const map = {};
    if(!phonesE164.length) return map;

    const run = async ()=> {
      const { data, error } = await supabase
        .from("leads")
        .select("id, phone, created_at")
        .eq("user_id", userId)
        .in("phone", phonesE164);
      if(error) return [];
      return data||[];
    };

    let rows = await run();
    if(rows.length < phonesE164.length){
      await new Promise(r=>setTimeout(r, 400)); // tiny index settle
      rows = await run();
    }
    // keep the latest per phone
    rows.sort((a,b)=> (a.phone===b.phone) ? (new Date(b.created_at)-new Date(a.created_at)) : 0);
    for(const r of rows){ if(!map[r.phone]) map[r.phone]=r.id; }
    return map;
  }

  async function sendBatch(valid, batchId){
    const [{ data: authUser }, { data: sess }] = await Promise.all([
      supabase.auth.getUser(),
      supabase.auth.getSession(),
    ]);
    const requesterId = authUser?.user?.id;
    const token = sess?.session?.access_token;
    if(!requesterId) { onServerMsg?.("⚠️ Not logged in."); return { ok:0, skipped:valid.length, errors:valid.length }; }

    const headers = {
      "Content-Type":"application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "X-Remie-Billing":"free_first",
    };

    // Build phone list and map lead ids
    const phonesE164 = Array.from(new Set(valid.map(p=>toE164(p.phone)).filter(Boolean)));
    const idMap = await mapLeadIdsByPhone(phonesE164, requesterId);

    const CONCURRENCY = 5;
    let i = 0, ok=0, skipped=0, errors=0;

    async function worker(){
      while(i < valid.length){
        const idx = i++;
        const p = valid[idx];
        try{
          const to = toE164(p.phone);
          if(!to){ skipped++; continue; }

          const lead_id = idMap[to] || null; // should be present now

          const res = await fetch(`${FN_BASE}/messages-send`, {
            method:"POST",
            headers,
            body: JSON.stringify({
              requesterId,
              to,
              lead_id,                 // ensures {{state}} & {{beneficiary}} fill from leads table
              body:"",                 // blank => server renders your default template
              billing:"free_first",
              preferFreeSegments:true,
              provider_message_id:`csv-${batchId}-${idx}`,
            })
          });
          const out = await res.json().catch(()=> ({}));
          if(res.ok && (out?.ok || out?.deduped)){ ok++; }
          else { console.warn("[csv-send] fail:", out); errors++; }
        }catch(e){
          console.warn("[csv-send] error", e); errors++;
        }
      }
    }
    const workers = Array.from({length:Math.min(CONCURRENCY, valid.length)}, ()=>worker());
    await Promise.all(workers);
    return { ok, skipped, errors };
  }

  return (
    <>
      <label className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-sm cursor-pointer">
        <input type="file" accept=".csv" className="hidden" onChange={(e)=>e.target.files?.[0] && handleImportCsv(e.target.files[0])}/>
        Import CSV
      </label>

      {/* Choice */}
      {choice && (
        <div className="fixed inset-0 z-50 grid bg-black/60 p-3">
          <div className="relative m-auto w-full max-w-lg rounded-2xl border border-white/15 bg-neutral-950 p-4">
            <div className="mb-2 text-base font-semibold">How do you want to import these leads?</div>
            <p className="text-sm text-white/70 mb-4">We found <span className="font-semibold text-white">{choice.count}</span> new contact(s) in your file.</p>
            <div className="flex items-center justify-end gap-2">
              <button
                className="rounded-xl border border-white/15 px-4 py-2 text-sm hover:bg-white/10"
                onClick={async ()=>{
                  const valid = choice.people.filter(p=>{
                    const hasPhone = !!String(p.phone||"").trim();
                    const okPhone = !hasPhone || !!toE164(p.phone);
                    return okPhone;
                  });
                  setChoice(null);
                  await persist(valid); // CRM only
                }}
              >
                Add to CRM only
              </button>

              <button
                className="rounded-xl bg-white px-4 py-2 text-sm font-medium text-black hover:bg-white/90"
                onClick={async ()=>{
                  const valid = choice.people.filter(p=>{
                    const hasPhone = !!String(p.phone||"").trim();
                    const okPhone = !hasPhone || !!toE164(p.phone);
                    return okPhone;
                  });
                  const skippedInvalid = choice.people.length - valid.length;

                  setChoice(null);

                  // 1) Save to CRM first (so lead rows exist)
                  await persist(valid);

                  // 2) Create/refresh contacts only on this path
                  try { await ensureContactsForPeople(valid); msg("👤 Contacts upserted for messaging."); } catch {}

                  // 3) Light pause to allow DB index
                  await new Promise(r=>setTimeout(r, 500));

                  const prev = await previewSend(valid);
                  setConfirm({ ...prev, people: valid, _skipped_invalid_phone: skippedInvalid });
                }}
              >
                Add &amp; Message Now
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm */}
      {confirm && (
        <div className="fixed inset-0 z-50 grid bg-black/60 p-3">
          <div className="relative m-auto w-full max-w-lg rounded-2xl border border-white/15 bg-neutral-950 p-4">
            <div className="mb-2 text-base font-semibold">Confirm bulk message</div>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between"><span>Candidates</span><span>{confirm.total_candidates}</span></div>
              <div className="flex justify-between"><span>Will send now</span><span>{confirm.will_send}</span></div>
              <div className="flex justify-between"><span>Billing mode</span><span>Free-first (10DLC)</span></div>
              <details className="mt-2">
                <summary className="cursor-pointer text-white/80">Skipped (preview)</summary>
                <div className="mt-2 grid gap-1 text-white/70">
                  {Object.entries(confirm.skipped_by_reason || {}).map(([k,v])=>(
                    <div key={k} className="flex justify-between">
                      <span className="capitalize">{k.replace(/_/g," ")}</span><span>{v}</span>
                    </div>
                  ))}
                  {confirm._skipped_invalid_phone>0 && (
                    <div className="flex justify-between"><span>invalid phone (import)</span><span>{confirm._skipped_invalid_phone}</span></div>
                  )}
                </div>
              </details>
            </div>

            <div className="mt-4 flex items-center justify-end gap-2">
              <button className="rounded-xl border border-white/15 px-4 py-2 text-sm hover:bg-white/10" onClick={()=>setConfirm(null)}>Back</button>
              <button
                disabled={isSending || confirm.will_send===0}
                className={`rounded-xl px-4 py-2 text-sm font-medium ${(!isSending && confirm.will_send>0) ? "bg-white text-black hover:bg-white/90" : "bg-white/20 text-white/60 cursor-not-allowed"}`}
                onClick={async ()=>{
                  try{
                    setIsSending(true);
                    onServerMsg?.("📨 Sending via 10DLC (free-first) …");
                    const res = await sendBatch(confirm.people, confirm.batch_id);
                    onServerMsg?.(`✅ Sent: ${res.ok}, skipped: ${res.skipped}, errors: ${res.errors}`);
                  } finally {
                    setIsSending(false);
                    setConfirm(null);
                  }
                }}
              >
                {isSending ? "Sending…" : "Send Now"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
