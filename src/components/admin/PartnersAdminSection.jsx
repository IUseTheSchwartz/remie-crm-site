import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabaseClient.js";
import { Instagram, Plus, Trash2, Save, RefreshCw } from "lucide-react";

const normHandle = (h) => (h || "").trim().replace(/^@/, "");

export default function PartnersAdminSection() {
  const [rows, setRows] = useState([]);
  const [draft, setDraft] = useState({
    name: "",
    role: "",
    bio: "",
    instagram_handle: "",
    photo_url: "",
    active: true,
    sort_order: "",
  });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  async function load() {
    setLoading(true);
    setErr("");
    try {
      const { data, error } = await supabase
        .from("partners")
        .select("*")
        .order("sort_order", { ascending: true, nullsFirst: true })
        .order("name", { ascending: true });
      if (error) throw error;
      setRows(data || []);
    } catch (e) {
      setErr(e.message || "Failed to load partners");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  function patchRow(id, patch) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  async function upsertRow(r) {
    setSaving(true);
    setErr("");
    try {
      const payload = {
        ...r,
        instagram_handle: normHandle(r.instagram_handle),
        sort_order:
          r.sort_order === "" || r.sort_order == null ? null : Number(r.sort_order),
      };
      const { error } = await supabase.from("partners").upsert(payload, { onConflict: "id" });
      if (error) throw error;
      await load();
    } catch (e) {
      setErr(e.message || "Failed to save partner");
    } finally {
      setSaving(false);
    }
  }

  async function removeRow(id) {
    if (!confirm("Delete this partner?")) return;
    setSaving(true);
    setErr("");
    try {
      const { error } = await supabase.from("partners").delete().eq("id", id);
      if (error) throw error;
      setRows((prev) => prev.filter((x) => x.id !== id));
    } catch (e) {
      setErr(e.message || "Failed to delete");
    } finally {
      setSaving(false);
    }
  }

  async function addNew() {
    const payload = {
      name: draft.name.trim(),
      role: draft.role.trim() || null,
      bio: draft.bio.trim() || null,
      instagram_handle: normHandle(draft.instagram_handle),
      photo_url: draft.photo_url.trim() || null,
      active: !!draft.active,
      sort_order:
        draft.sort_order === "" || draft.sort_order == null
          ? null
          : Number(draft.sort_order),
    };
    if (!payload.name) { setErr("Name is required"); return; }
    setSaving(true);
    setErr("");
    try {
      const { error } = await supabase.from("partners").insert(payload);
      if (error) throw error;
      setDraft({
        name: "", role: "", bio: "", instagram_handle: "", photo_url: "",
        active: true, sort_order: "",
      });
      await load();
    } catch (e) {
      setErr(e.message || "Failed to add partner");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Partners</h2>
        <button
          onClick={load}
          disabled={loading}
          className="inline-flex items-center gap-2 rounded-lg border border-white/20 px-3 py-1.5 text-sm hover:bg-white/10"
        >
          <RefreshCw className="h-4 w-4" />
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {err && (
        <div className="rounded-lg border border-rose-400/30 bg-rose-500/10 p-3 text-sm text-rose-200">
          {err}
        </div>
      )}

      {/* Add form */}
      <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4 ring-1 ring-white/5">
        <h3 className="mb-3 font-medium text-white/90">Add Partner</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <input className="rounded-md border border-white/15 bg-black/40 px-3 py-2"
            placeholder="Name *" value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
          <input className="rounded-md border border-white/15 bg-black/40 px-3 py-2"
            placeholder="Role (e.g., Agency Partner)" value={draft.role}
            onChange={(e) => setDraft((d) => ({ ...d, role: e.target.value }))} />
          <input className="rounded-md border border-white/15 bg-black/40 px-3 py-2"
            placeholder="Instagram (handle or @handle)" value={draft.instagram_handle}
            onChange={(e) => setDraft((d) => ({ ...d, instagram_handle: e.target.value }))} />
          <input className="rounded-md border border-white/15 bg-black/40 px-3 py-2"
            placeholder="Photo URL (https…)" value={draft.photo_url}
            onChange={(e) => setDraft((d) => ({ ...d, photo_url: e.target.value }))} />
          <input className="rounded-md border border-white/15 bg-black/40 px-3 py-2"
            placeholder="Sort order (number; lower shows first)" value={draft.sort_order}
            onChange={(e) => setDraft((d) => ({ ...d, sort_order: e.target.value }))} />
          <label className="inline-flex items-center gap-2">
            <input type="checkbox" checked={!!draft.active}
              onChange={(e) => setDraft((d) => ({ ...d, active: e.target.checked }))} />
            <span className="text-white/80">Active</span>
          </label>
        </div>
        <div className="mt-3">
          <button
            onClick={addNew}
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-lg border border-emerald-400/30 px-3 py-1.5 text-sm hover:bg-emerald-400/10"
          >
            <Plus className="h-4 w-4" />
            {saving ? "Adding…" : "Add partner"}
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-2xl border border-white/10">
        <table className="min-w-full text-sm">
          <thead className="bg-white/5">
            <tr>
              <th className="px-3 py-2 text-left text-white/70">Photo</th>
              <th className="px-3 py-2 text-left text-white/70">Name</th>
              <th className="px-3 py-2 text-left text-white/70">Role</th>
              <th className="px-3 py-2 text-left text-white/70">Instagram</th>
              <th className="px-3 py-2 text-left text-white/70">Active</th>
              <th className="px-3 py-2 text-left text-white/70">Sort</th>
              <th className="px-3 py-2 text-left text-white/70">Bio</th>
              <th className="px-3 py-2 text-left text-white/70">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-white/10 align-top">
                <td className="px-3 py-2">
                  {r.photo_url ? (
                    <img src={r.photo_url} alt={`${r.name} headshot`}
                      className="h-12 w-12 rounded-lg object-cover ring-1 ring-white/15" />
                  ) : <div className="h-12 w-12 rounded-lg bg-white/5" />}
                </td>
                <td className="px-3 py-2">
                  <input className="w-44 rounded-md border border-white/15 bg-black/40 px-2 py-1"
                    value={r.name || ""} onChange={(e) => patchRow(r.id, { name: e.target.value })} />
                </td>
                <td className="px-3 py-2">
                  <input className="w-40 rounded-md border border-white/15 bg-black/40 px-2 py-1"
                    value={r.role || ""} onChange={(e) => patchRow(r.id, { role: e.target.value })} />
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <Instagram className="h-4 w-4 text-white/60" />
                    <input className="w-48 rounded-md border border-white/15 bg-black/40 px-2 py-1"
                      placeholder="handle" value={r.instagram_handle || ""}
                      onChange={(e) => patchRow(r.id, { instagram_handle: e.target.value })} />
                  </div>
                </td>
                <td className="px-3 py-2">
                  <label className="inline-flex items-center gap-2">
                    <input type="checkbox" checked={!!r.active}
                      onChange={(e) => patchRow(r.id, { active: e.target.checked })} />
                    <span className="text-white/80">On</span>
                  </label>
                </td>
                <td className="px-3 py-2">
                  <input type="number" className="w-20 rounded-md border border-white/15 bg-black/40 px-2 py-1"
                    value={r.sort_order ?? ""} onChange={(e) => patchRow(r.id, { sort_order: e.target.value })} />
                </td>
                <td className="px-3 py-2">
                  <textarea rows={3} className="w-80 rounded-md border border-white/15 bg-black/40 px-2 py-1"
                    value={r.bio || ""} onChange={(e) => patchRow(r.id, { bio: e.target.value })} />
                </td>
                <td className="px-3 py-2 space-x-2">
                  <button onClick={() => upsertRow(r)}
                    className="inline-flex items-center gap-2 rounded-md border border-white/20 px-3 py-1 hover:bg-white/10">
                    <Save className="h-4 w-4" /> Save
                  </button>
                  <button onClick={() => removeRow(r.id)}
                    className="inline-flex items-center gap-2 rounded-md border border-rose-400/30 px-3 py-1 hover:bg-rose-400/10">
                    <Trash2 className="h-4 w-4" /> Delete
                  </button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && !loading && (
              <tr><td className="px-3 py-6 text-center text-white/60" colSpan={8}>No partners yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-white/50">
        Public site reads: <code>select * from partners where active=true order by sort_order nulls last, name asc</code>
      </p>
    </section>
  );
}
