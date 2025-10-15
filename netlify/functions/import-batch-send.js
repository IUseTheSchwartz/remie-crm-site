// File: src/components/leads/CsvImportControl.jsx
import { useState } from "react";
import Papa from "papaparse";
import { supabase } from "../../lib/supabaseClient.js";
import { toE164 } from "../../lib/phone.js";
import { normalizePerson } from "../../lib/storage.js";
import { upsertManyLeadsServer } from "../../lib/supabaseLeads.js";

const FN_BASE = import.meta.env?.VITE_FUNCTIONS_BASE || "/.netlify/functions";

/* helpers copied from your page so behavior matches */
function stripBOM(s){return String(s||"").replace(/^\uFEFF/,"")}
const norm = (s)=>stripBOM(s).trim().toLowerCase();
function cleanEmail(e){const v=stripBOM(String(e||"").trim().toLowerCase()); if(!v) return ""; const junk=new Set(["n/a","na","none","-","null","unknown","noemail","no email"]); return junk.has(v)?"":v;}
function canonicalDigits(s){const d=String(s||"").replace(/\D+/g,""); if(!d) return ""; return d.slice(-10);}
const onlyDigits=(s)=>String(s||"").replace(/\D+/g,"");
const normEmail=(s)=>String(s||"").trim().toLowerCase();

/* header mapping (short version: full set from your code) */
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
    if(c.includes("branch") && nh.includes("branch")) return true;
    if(c==="military"){ return nh==="military" || nh.includes("branch");}
    if(nh.includes(c) && c.length>3) return true;
    return false;
  };
  const find=(cands)=>{
    // exact
    for(let i=0;i<normalized.length;i++){ for(const cand of cands){ if(normalized[i]===cand) return headers[i];}}
    // prefer "branch" for military
    for(let i=0;i<normalized.length;i++){ if(normalized[i].includes("branch")){ for(const cand of cands){ if(matches(normalized[i],cand)) return headers[i];}}}
    // loose
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

const pick=(row,key)=>{ if(!key) return ""; const v=row[key]; return v==null?"":String(v).trim(); }

function buildName(row,map){
  // prefer explicit full name
  const full=pick(row,map.full); if(full) return full;
  // combine first + last (either one can be empty)
  const first=pick(row,map.first);
  const last=pick(row,map.last);
  const combined=`${first} ${last}`.trim();
  if(combined) return combined;
  // fallbacks
  const company=pick(row,map.company); if(company) return company;
  const email=pick(row,map.email); if(email && email.includes("@")) return email.split("@")[0];
  return "";
}

const buildPhone=(row,map)=> pick(row,map.phone) || row.phone || row.number || row.Phone || row.Number || "";
const buildEmail=(row,map)=> pick(row,map.email) || row.email || row.Email || "";
const buildNotes=(row,map)=> pick(row,map.notes) || "";
const buildDob=(row,map)=> pick(row,map.dob);
const buildState=(row,map)=> pick(row,map.state).toUpperCase();
const buildBeneficiary=(row,map)=> pick(row,map.beneficiary);
const buildBeneficiaryName=(row,map)=> pick(row,map.beneficiary_name);
const buildGender=(row,map)=> pick(row,map.gender);
const buildMilitaryBranch=(row,map)=> pick(row,map.military_branch);

export default function CsvImportControl({ onAddedLocal, onServerMsg }) {
  const [choice, setChoice] = useState(null);   // {count, people}
  const [confirm, setConfirm] = useState(null); // preview payload
  const [isSending, setIsSending] = useState(false);

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  function msg(s){ onServerMsg?.(s); }

  async function runDryRun(people){
    const { data: auth } = await supabase.auth.getUser();
    const requesterId = auth?.user?.id;
    if(!requesterId){ alert("Not logged in."); return null; }
    const res = await fetch(`${FN_BASE}/import-batch-send`, {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ requesterId, dry_run:true, batch_id:Math.random().toString(36).slice(2,10), people })
    });
    const out = await res.json().catch(()=>({}));
    return { status: res.status, out };
  }

  async function handleImportCsv(file){
    Papa.parse(file, {
      header:true, skipEmptyLines:true,
      transformHeader:(h)=>stripBOM(h).trim(),
      complete: async (res) => {
        const rows = res.data || [];
        if(!rows.length){ alert("CSV has no rows."); return; }

        // existing local dedupe keys
        let existing = [];
        try {
          const leads = JSON.parse(localStorage.getItem("remie_leads")||"[]");
          const clients = JSON.parse(localStorage.getItem("remie_clients")||"[]");
          existing = [...leads, ...clients];
        } catch {}

        const headers = Object.keys(rows[0] || {});
        const map = buildHeaderIndex(headers);

        const existingEmails = new Set(existing.map(r=>cleanEmail(r.email)).filter(Boolean));
        const existingPhones = new Set(existing.map(r=>canonicalDigits(r.phone)).filter(Boolean));
        const seenEmails = new Set(); const seenPhones = new Set();

        const uniqueToAdd=[]; let skippedDupEmail=0, skippedDupPhone=0, skippedEmpty=0;

        for(const r of rows){
          const name  = r.name || r.Name || buildName(r,map);
          const phone = buildPhone(r,map);
          const email = buildEmail(r,map);
          const notes = buildNotes(r,map);
          const dob = buildDob(r,map);
          const state = buildState(r,map);
          const beneficiary = buildBeneficiary(r,map);
          const beneficiary_name = buildBeneficiaryName(r,map);
          const gender = buildGender(r,map);
          const military_branch = buildMilitaryBranch(r,map);

          const person = normalizePerson({
            name, phone, email, notes,
            stage:"no_pickup",
            dob, state, beneficiary, beneficiary_name, gender, military_branch,
          });

          const e = cleanEmail(person.email);
          const p = canonicalDigits(person.phone);

          if(!(person.name || e || p)){ skippedEmpty++; continue; }

          const emailDup = e && (existingEmails.has(e) || seenEmails.has(e));
          const phoneDup = p && (existingPhones.has(p) || seenPhones.has(p));
          if(emailDup || phoneDup){ if(emailDup) skippedDupEmail++; if(phoneDup) skippedDupPhone++; continue; }

          if(e) seenEmails.add(e); if(p) seenPhones.add(p);
          uniqueToAdd.push(person);
        }

        if(!uniqueToAdd.length){
          const parts=[];
          if(skippedDupEmail) parts.push(`${skippedDupEmail} email dupes`);
          if(skippedDupPhone) parts.push(`${skippedDupPhone} phone dupes`);
          if(skippedEmpty) parts.push(`${skippedEmpty} empty rows`);
          const detail = parts.length ? ` (${parts.join(", ")})` : "";
          msg(`No new leads found in CSV (duplicates skipped)${detail}.`);
          return;
        }

        setChoice({ count: uniqueToAdd.length, people: uniqueToAdd });
      },
      error: (err)=> alert("CSV parse error: "+err.message),
    });
  }

  async function persist(valid){
    // optimistic local for parent
    onAddedLocal?.(valid);
    // upsert to server
    try {
      msg(`Syncing ${valid.length} new lead(s) to Supabase…`);
      const wrote = await upsertManyLeadsServer(valid);
      msg(`✅ CSV synced (${wrote} saved)`);
    } catch(e){
      console.error(e);
      msg(`⚠️ CSV sync failed: ${e.message || e}`);
    }
  }

  return (
    <>
      <label className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-sm cursor-pointer">
        <input
          type="file"
          accept=".csv"
          className="hidden"
          onChange={(e)=>e.target.files?.[0] && handleImportCsv(e.target.files[0])}
        />
        Import CSV
      </label>

      {/* Choice modal */}
      {choice && (
        <div className="fixed inset-0 z-50 grid bg-black/60 p-3">
          <div className="relative m-auto w-full max-w-lg rounded-2xl border border-white/15 bg-neutral-950 p-4">
            <div className="mb-2 text-base font-semibold">How do you want to import these leads?</div>
            <p className="text-sm text-white/70 mb-4">
              We found <span className="font-semibold text-white">{choice.count}</span> new contact(s) in your file.
            </p>
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
                  await persist(valid);
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

                  // 1) Close chooser
                  setChoice(null);

                  // 2) Save first (local + Supabase) so the preview can match leads
                  await persist(valid);

                  // 3) Small pause to let DB index on slower networks
                  await sleep(400);

                  // 4) Now preview the send
                  const { status, out } = await runDryRun(valid) || {};
                  if(!out) return;
                  if(status===403 && out?.error==="disabled"){ onServerMsg?.("⚠️ Bulk messaging is disabled by env flag."); return; }
                  if(status===413 && out?.error==="over_cap"){ onServerMsg?.(`⚠️ Over batch cap (${out.cap}). Reduce your file size.`); return; }
                  if(out.error){ onServerMsg?.("⚠️ Preview failed. See console for details."); console.warn("[dry-run] fail", out); return; }

                  setConfirm({
                    ...out,
                    people: valid,
                    _skipped_invalid_phone: skippedInvalid,
                  });
                }}
              >
                Add &amp; Message Now
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm modal */}
      {confirm && (
        <div className="fixed inset-0 z-50 grid bg-black/60 p-3">
          <div className="relative m-auto w-full max-w-lg rounded-2xl border border-white/15 bg-neutral-950 p-4">
            <div className="mb-2 text-base font-semibold">Confirm bulk message</div>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between"><span>Candidates</span><span>{confirm.total_candidates}</span></div>
              <div className="flex justify-between"><span>Will send now</span><span>{confirm.will_send}</span></div>
              <div className="flex justify-between"><span>Estimated cost</span><span>${(confirm.estimated_cost_cents/100).toFixed(2)}</span></div>
              {typeof confirm.wallet_balance_cents==="number" && (
                <div className="flex justify-between"><span>Wallet balance</span><span>${(confirm.wallet_balance_cents/100).toFixed(2)}</span></div>
              )}
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
              {confirm.blocker && (
                <div className="mt-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-amber-200">
                  {confirm.blocker==="tfn_pending_verification" && "Your toll-free number is pending verification. You can still proceed; delivery may fail if your provider blocks sends."}
                  {confirm.blocker==="no_agent_tfn_configured" && "No verified toll-free number is configured. You can proceed; sends may fail until a TFN is configured."}
                  {confirm.blocker==="insufficient_balance" && "Insufficient wallet balance to send this batch."}
                </div>
              )}
            </div>

            <div className="mt-4 flex items-center justify-end gap-2">
              <button className="rounded-xl border border-white/15 px-4 py-2 text-sm hover:bg-white/10" onClick={()=>setConfirm(null)}>Back</button>
              <button
                // <<< CHANGE: don't block on confirm.blocker; allow as long as there is something to send and we're not already sending
                disabled={isSending || confirm.will_send===0}
                className={`rounded-xl px-4 py-2 text-sm font-medium ${(confirm.will_send>0 && !isSending) ? "bg-white text-black hover:bg-white/90" : "bg-white/20 text-white/60 cursor-not-allowed"}`}
                onClick={async ()=>{
                  try{
                    setIsSending(true);
                    onServerMsg?.("📨 Sending messages…");
                    const { data: auth } = await supabase.auth.getUser();
                    const requesterId = auth?.user?.id;
                    const res = await fetch(`${FN_BASE}/import-batch-send`, {
                      method:"POST",
                      headers:{ "Content-Type":"application/json" },
                      body: JSON.stringify({ requesterId, batch_id: confirm.batch_id, people: confirm.people })
                    });
                    const out = await res.json().catch(()=>({}));
                    if(res.status===402 && out?.stop==="insufficient_balance"){ onServerMsg?.("⚠️ Not enough balance to send this batch."); }
                    else if(res.status===409 && out?.stop){ onServerMsg?.("⚠️ Provider blocked send (TFN not verified/configured)."); }
                    else if(res.ok){ onServerMsg?.(`✅ Sent: ${out.ok}, skipped: ${out.skipped}, errors: ${out.errors}`); }
                    else { onServerMsg?.("⚠️ Batch send failed. See console."); console.warn("[import-batch-send] send fail", out); }
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
