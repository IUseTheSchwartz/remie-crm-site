import { useState } from "react";
import { supabase } from "../../lib/supabaseClient.js";
import { normalizePerson } from "../../lib/storage.js";
import { upsertLeadServer } from "../../lib/supabaseLeads.js";

export default function AddLeadControl({ onAddedLocal, onServerMsg }) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    name: "", phone: "", email: "", notes: "",
    dob: "", state: "", beneficiary: "",
    beneficiary_name: "", gender: "", military_branch: "",
  });

  function msg(s) { onServerMsg?.(s); }

  async function onSave(e) {
    e.preventDefault();
    const person = normalizePerson({ ...form, stage: "no_pickup" });
    if (!(person.name || person.phone || person.email)) {
      alert("Enter at least a name, phone, or email."); return;
    }
    try {
      setSaving(true);
      msg("Saving lead to Supabase…");
      await upsertLeadServer(person);

      // optimistic local insert in parent
      onAddedLocal?.([person]);
      msg("✅ Lead saved");
      setOpen(false);
      setForm({
        name: "", phone: "", email: "", notes: "",
        dob: "", state: "", beneficiary: "",
        beneficiary_name: "", gender: "", military_branch: "",
      });
    } catch (e) {
      console.error(e);
      msg(`⚠️ Save failed: ${e.message || e}`);
    } finally { setSaving(false); }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm"
        title="Manually add a single lead"
      >
        Add lead
      </button>

      {open && (
        <div className="fixed inset-0 z-50 grid bg-black/60 p-3">
          <div className="relative m-auto w-full max-w-xl rounded-2xl border border-white/15 bg-neutral-950 p-4">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-base font-semibold">Add lead</div>
              <button onClick={() => setOpen(false)} className="rounded-lg px-2 py-1 text-sm hover:bg-white/10">Close</button>
            </div>

            <form onSubmit={onSave} className="grid gap-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Name">
                  <input className="inp" value={form.name} onChange={e=>setForm({...form,name:e.target.value})} placeholder="Jane Doe"/>
                </Field>
                <Field label="Phone">
                  <input className="inp" value={form.phone} onChange={e=>setForm({...form,phone:e.target.value})} placeholder="(555) 123-4567"/>
                </Field>
              </div>
              <Field label="Email">
                <input className="inp" value={form.email} onChange={e=>setForm({...form,email:e.target.value})} placeholder="jane@example.com"/>
              </Field>
              <Field label="Notes">
                <input className="inp" value={form.notes} onChange={e=>setForm({...form,notes:e.target.value})} placeholder="Any context about the lead"/>
              </Field>

              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="DOB"><input className="inp" value={form.dob} onChange={e=>setForm({...form,dob:e.target.value})} placeholder="MM-DD-YYYY"/></Field>
                <Field label="State"><input className="inp" value={form.state} onChange={e=>setForm({...form,state:e.target.value.toUpperCase()})} placeholder="TN"/></Field>
                <Field label="Beneficiary"><input className="inp" value={form.beneficiary} onChange={e=>setForm({...form,beneficiary:e.target.value})}/></Field>
                <Field label="Beneficiary Name"><input className="inp" value={form.beneficiary_name} onChange={e=>setForm({...form,beneficiary_name:e.target.value})}/></Field>
                <Field label="Gender"><input className="inp" value={form.gender} onChange={e=>setForm({...form,gender:e.target.value})}/></Field>
                <Field label="Military Branch"><input className="inp" value={form.military_branch} onChange={e=>setForm({...form,military_branch:e.target.value})} placeholder="Army / Navy / …"/></Field>
              </div>

              <div className="mt-3 flex items-center justify-end gap-2">
                <button type="button" onClick={()=>setOpen(false)} className="rounded-xl border border-white/15 px-4 py-2 text-sm hover:bg-white/10">Cancel</button>
                <button disabled={saving} type="submit" className="rounded-xl bg-white px-4 py-2 text-sm font-medium text-black hover:bg-white/90">
                  {saving ? "Saving…" : "Save lead"}
                </button>
              </div>
            </form>
          </div>

          <style>{`.inp{width:100%; border-radius:.75rem; border:1px solid rgba(255,255,255,.1); background:#00000066; padding:.5rem .75rem; outline:none}
          .inp:focus{box-shadow:0 0 0 2px rgba(99,102,241,.4)}`}</style>
        </div>
      )}
    </>
  );
}

function Field({ label, children }) {
  return (
    <label className="text-sm">
      <div className="mb-1 text-white/70">{label}</div>
      {children}
    </label>
  );
}
