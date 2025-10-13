// File: src/pages/ReviewsManager.jsx
import { useEffect, useMemo, useState } from "react";
import { Star, Plus, Trash2, Edit3, Save, X, Eye, EyeOff, Loader2 } from "lucide-react";
import { supabase } from "../lib/supabaseClient.js";
import { useAuth } from "../auth.jsx";

/* --------- small star input widget --------- */
function StarInput({ value = 0, onChange, disabled }) {
  const [hover, setHover] = useState(null);
  const display = hover ?? value;
  const steps = [1, 2, 3, 4, 5];

  const fill = (i) =>
    display >= i
      ? "bg-gradient-to-br from-indigo-500 via-purple-500 to-fuchsia-500"
      : "bg-white/0";
  const outline = "ring-1 ring-white/20";

  return (
    <div className="inline-flex items-center gap-1 select-none">
      {steps.map((i) => (
        <button
          key={i}
          type="button"
          disabled={disabled}
          onMouseEnter={() => setHover(i)}
          onMouseLeave={() => setHover(null)}
          onClick={() => onChange?.(i)}
          className={`h-6 w-6 rounded-md ${outline} ${fill(i)} grid place-items-center disabled:opacity-50`}
          title={`${i} star${i > 1 ? "s" : ""}`}
        >
          <Star className="h-3.5 w-3.5 text-white" />
        </button>
      ))}
    </div>
  );
}

export default function ReviewsManager() {
  const { user } = useAuth();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [err, setErr] = useState("");
  const [creating, setCreating] = useState(false);
  const [newRow, setNewRow] = useState({
    rating: 5,
    reviewer_name: "",
    comment: "",
    is_public: true,
  });

  const canUse = !!user?.id;

  async function load() {
    if (!canUse) return;
    setLoading(true);
    setErr("");
    try {
      const { data, error } = await supabase
        .from("agent_reviews")
        .select(
          "id, agent_id, rating, comment, reviewer_name, is_public, created_at"
        )
        .eq("agent_id", user.id)
        .order("created_at", { ascending: false });
      if (error) throw error;
      setRows(data || []);
    } catch (e) {
      setErr(e?.message || "Failed to load reviews.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  const avg = useMemo(() => {
    if (!rows.length) return 0;
    return (
      Math.round(
        (rows.reduce((s, r) => s + Number(r.rating || 0), 0) / rows.length) *
          10
      ) / 10
    );
  }, [rows]);

  async function createRow() {
    if (!newRow.rating) return;
    setCreating(true);
    setErr("");
    try {
      const payload = {
        agent_id: user.id,
        rating: Number(newRow.rating),
        comment: (newRow.comment || "").trim(),
        reviewer_name: (newRow.reviewer_name || "").trim() || null,
        is_public: !!newRow.is_public,
      };
      const { data, error } = await supabase
        .from("agent_reviews")
        .insert(payload)
        .select()
        .single();
      if (error) throw error;
      setRows((r) => [data, ...r]);
      setNewRow({ rating: 5, reviewer_name: "", comment: "", is_public: true });
    } catch (e) {
      setErr(e?.message || "Failed to create review.");
    } finally {
      setCreating(false);
    }
  }

  function startEdit(id) {
    setRows((r) =>
      r.map((x) =>
        x.id === id
          ? {
              ...x,
              _editing: {
                reviewer_name: x.reviewer_name || "",
                comment: x.comment || "",
                rating: x.rating,
              },
            }
          : x
      )
    );
  }

  function cancelEdit(id) {
    setRows((r) => r.map((x) => (x.id === id ? { ...x, _editing: null } : x)));
  }

  async function saveEdit(id) {
    const row = rows.find((r) => r.id === id);
    if (!row?._editing) return;
    setBusyId(id);
    setErr("");
    try {
      const upd = {
        reviewer_name: (row._editing.reviewer_name || "").trim() || null,
        comment: (row._editing.comment || "").trim(),
        rating: Number(row._editing.rating || 0),
      };
      const { data, error } = await supabase
        .from("agent_reviews")
        .update(upd)
        .eq("id", id)
        .eq("agent_id", user.id)
        .select()
        .single();
      if (error) throw error;
      setRows((r) =>
        r.map((x) => (x.id === id ? { ...data, _editing: null } : x))
      );
    } catch (e) {
      setErr(e?.message || "Failed to save changes.");
    } finally {
      setBusyId(null);
    }
  }

  async function togglePublic(id, is_public) {
    setBusyId(id);
    setErr("");
    try {
      const { data, error } = await supabase
        .from("agent_reviews")
        .update({ is_public: !is_public })
        .eq("id", id)
        .eq("agent_id", user.id)
        .select()
        .single();
      if (error) throw error;
      setRows((r) => r.map((x) => (x.id === id ? data : x)));
    } catch (e) {
      setErr(e?.message || "Failed to update visibility.");
    } finally {
      setBusyId(null);
    }
  }

  async function remove(id) {
    if (!confirm("Delete this review?")) return;
    setBusyId(id);
    setErr("");
    try {
      const { error } = await supabase
        .from("agent_reviews")
        .delete()
        .eq("id", id)
        .eq("agent_id", user.id);
      if (error) throw error;
      setRows((r) => r.filter((x) => x.id !== id));
    } catch (e) {
      setErr(e?.message || "Failed to delete.");
    } finally {
      setBusyId(null);
    }
  }

  if (!canUse) {
    return (
      <div className="p-4 text-white/70">
        You need to be logged in to manage reviews.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Client Reviews</h1>
          <div className="text-sm text-white/60">
            Average: <span className="font-medium text-white">{avg || "—"}</span> / 5 • {rows.length} total
          </div>
        </div>
        <button
          onClick={() =>
            setNewRow((n) => ({ ...n, is_public: !n.is_public }))
          }
          className="rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-sm hover:bg-white/10"
          title="Default visibility for new review"
        >
          New reviews: {newRow.is_public ? "Public" : "Hidden"}
        </button>
      </header>

      {/* create */}
      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 ring-1 ring-white/5">
        <div className="text-sm font-medium mb-3">Add Review (manual)</div>
        <div className="grid gap-3 md:grid-cols-[minmax(180px,220px)_1fr_minmax(140px,220px)_auto]">
          <div>
            <div className="text-xs text-white/60 mb-1">Rating</div>
            <StarInput
              value={newRow.rating}
              onChange={(v) => setNewRow((n) => ({ ...n, rating: v }))}
              disabled={creating}
            />
          </div>
          <div>
            <div className="text-xs text-white/60 mb-1">Reviewer name (optional)</div>
            <input
              value={newRow.reviewer_name}
              onChange={(e) =>
                setNewRow((n) => ({ ...n, reviewer_name: e.target.value }))
              }
              placeholder="e.g., Maria R."
              className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500/40"
              disabled={creating}
            />
          </div>
          <div>
            <div className="text-xs text-white/60 mb-1">Comment</div>
            <input
              value={newRow.comment}
              onChange={(e) =>
                setNewRow((n) => ({ ...n, comment: e.target.value }))
              }
              placeholder="Short feedback"
              className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500/40"
              disabled={creating}
            />
          </div>
          <div className="flex items-end">
            <button
              onClick={createRow}
              disabled={creating}
              className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-sm hover:bg-white/10 disabled:opacity-50"
            >
              {creating ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
              Add
            </button>
          </div>
        </div>
        <div className="mt-2 text-[11px] text-white/50">
          Tip: You can keep internal notes as hidden reviews (toggle visibility per row).
        </div>
      </div>

      {/* list */}
      <div className="rounded-2xl border border-white/10 bg-white/[0.03] ring-1 ring-white/5 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
          <div className="text-sm font-medium">Reviews ({rows.length})</div>
          {loading && (
            <div className="text-xs text-white/60 inline-flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
            </div>
          )}
        </div>

        {err && <div className="px-4 py-2 text-sm text-rose-300">{err}</div>}

        {rows.length === 0 && !loading ? (
          <div className="px-4 py-6 text-sm text-white/60">No reviews yet.</div>
        ) : (
          <ul className="divide-y divide-white/10">
            {rows.map((r) => (
              <li key={r.id} className="px-4 py-3">
                <div className="grid gap-3 md:grid-cols-[minmax(160px,220px)_1fr_minmax(180px,260px)_auto] md:items-center">
                  {/* rating & visibility */}
                  <div className="flex items-center gap-3">
                    <StarInput
                      value={r._editing ? r._editing.rating : r.rating}
                      onChange={(v) =>
                        setRows((rows) =>
                          rows.map((x) =>
                            x.id === r.id
                              ? {
                                  ...x,
                                  _editing: { ...(x._editing || r), rating: v },
                                }
                              : x
                          )
                        )
                      }
                      disabled={!r._editing || busyId === r.id}
                    />
                    <button
                      onClick={() => togglePublic(r.id, r.is_public)}
                      disabled={busyId === r.id}
                      className="rounded-lg border border-white/15 bg-white/5 px-2.5 py-1.5 text-xs hover:bg-white/10 inline-flex items-center gap-1 disabled:opacity-60"
                      title={r.is_public ? "Hide from public page" : "Make public"}
                    >
                      {r.is_public ? (
                        <Eye className="h-3.5 w-3.5" />
                      ) : (
                        <EyeOff className="h-3.5 w-3.5" />
                      )}
                      {r.is_public ? "Public" : "Hidden"}
                    </button>
                  </div>

                  {/* name */}
                  <div>
                    <div className="text-xs text-white/60 mb-1">Reviewer</div>
                    <input
                      value={
                        r._editing ? r._editing.reviewer_name : r.reviewer_name || ""
                      }
                      onChange={(e) =>
                        setRows((rows) =>
                          rows.map((x) =>
                            x.id === r.id
                              ? {
                                  ...x,
                                  _editing: {
                                    ...(x._editing || r),
                                    reviewer_name: e.target.value,
                                  },
                                }
                              : x
                          )
                        )
                      }
                      className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500/40 disabled:opacity-50"
                      disabled={!r._editing || busyId === r.id}
                      placeholder="Anonymous"
                    />
                  </div>

                  {/* comment */}
                  <div>
                    <div className="text-xs text-white/60 mb-1">Comment</div>
                    <input
                      value={r._editing ? r._editing.comment : r.comment || ""}
                      onChange={(e) =>
                        setRows((rows) =>
                          rows.map((x) =>
                            x.id === r.id
                              ? {
                                  ...x,
                                  _editing: {
                                    ...(x._editing || r),
                                    comment: e.target.value,
                                  },
                                }
                              : x
                          )
                        )
                      }
                      className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500/40 disabled:opacity-50"
                      disabled={!r._editing || busyId === r.id}
                      placeholder="Optional feedback"
                    />
                  </div>

                  {/* actions */}
                  <div className="flex items-center justify-end gap-2">
                    {r._editing ? (
                      <>
                        <button
                          onClick={() => saveEdit(r.id)}
                          disabled={busyId === r.id}
                          className="inline-flex items-center gap-2 rounded-lg border border-emerald-400/30 bg-emerald-500/10 px-3 py-1.5 text-sm text-emerald-200 hover:bg-emerald-500/15 disabled:opacity-60"
                        >
                          <Save className="h-4 w-4" /> Save
                        </button>
                        <button
                          onClick={() => cancelEdit(r.id)}
                          disabled={busyId === r.id}
                          className="inline-flex items-center gap-2 rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-sm hover:bg-white/10 disabled:opacity-60"
                        >
                          <X className="h-4 w-4" /> Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          onClick={() => startEdit(r.id)}
                          className="inline-flex items-center gap-2 rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-sm hover:bg-white/10"
                        >
                          <Edit3 className="h-4 w-4" /> Edit
                        </button>
                        <button
                          onClick={() => remove(r.id)}
                          disabled={busyId === r.id}
                          className="inline-flex items-center gap-2 rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-1.5 text-sm text-rose-200 hover:bg-rose-500/15 disabled:opacity-60"
                        >
                          <Trash2 className="h-4 w-4" /> Delete
                        </button>
                      </>
                    )}
                  </div>
                </div>

                <div className="mt-1 text-[11px] text-white/50">
                  {new Date(r.created_at).toLocaleString()}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
