// File: src/pages/ContactsPage.jsx
import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import {
  Loader2,
  Trash2,
  Search,
  MessageSquare,
  X,
  Plus,
  Minus,
  CheckCircle2,
  ChevronsUpDown,
} from "lucide-react";

/* ---------------- Templates catalog (global enable switches) ---------------- */
const TEMPLATE_DEFS = [
  { key: "new_lead", label: "New Lead" },
  { key: "new_lead_military", label: "New Lead (military)" },
  { key: "appointment", label: "Appointment" },
  { key: "sold", label: "Sold" },
  { key: "payment_reminder", label: "Payment" },
  { key: "birthday_text", label: "Birthday" },
  { key: "holiday_text", label: "Holiday" },
];
const DEFAULT_ENABLED = Object.fromEntries(TEMPLATE_DEFS.map((t) => [t.key, false]));

/* ---------------- Tag catalogs ---------------- */
/** Tags that actually map to templates (primary palette) */
const TEMPLATE_TAGS = [
  "lead",
  "sold",
  "birthday_text",
  "holiday_text",
  "appointment",
  "payment_reminder",
  // helper synonyms that still map to the above templates:
  "bday",          // -> birthday_text
  "holiday",       // -> holiday_text
  "payment",       // -> payment_reminder
  "military",      // -> new_lead_military
];

/** Optional extra suggestions shown only when "Show all tags" is toggled */
const EXTRA_TAG_SUGGESTIONS = [
  "vip",
  "facebook",
  "instagram",
  "follow_up",
  "referral",
];

/* ---------------- Helpers ---------------- */
function normalizeTag(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
}
function uniqueTags(arr) {
  const out = [];
  const seen = new Set();
  for (const t of arr || []) {
    const n = normalizeTag(t);
    if (n && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

/** Template eligibility from tags + subscribed + global enables */
function eligibleTemplatesForContact({ tags = [], subscribed }, enabledMap) {
  if (!subscribed) return [];
  const set = new Set(tags.map(normalizeTag));
  const elig = [];

  if (enabledMap.sold && set.has("sold")) elig.push({ key: "sold", label: "Sold" });
  if (enabledMap.birthday_text && (set.has("birthday_text") || set.has("bday"))) {
    elig.push({ key: "birthday_text", label: "Birthday" });
  }
  if (enabledMap.holiday_text && (set.has("holiday_text") || set.has("holiday"))) {
    elig.push({ key: "holiday_text", label: "Holiday" });
  }
  if (enabledMap.payment_reminder && (set.has("payment_reminder") || set.has("payment"))) {
    elig.push({ key: "payment_reminder", label: "Payment" });
  }
  if (enabledMap.appointment && set.has("appointment")) {
    elig.push({ key: "appointment", label: "Appointment" });
  }
  if (enabledMap.new_lead && set.has("lead")) {
    elig.push({ key: "new_lead", label: "New Lead" });
  }
  if (enabledMap.new_lead_military && set.has("military")) {
    elig.push({ key: "new_lead_military", label: "New Lead (military)" });
  }
  return elig;
}

export default function ContactsPage() {
  const [loading, setLoading] = useState(true);
  const [contacts, setContacts] = useState([]);
  const [enabledMap, setEnabledMap] = useState({ ...DEFAULT_ENABLED });

  const [q, setQ] = useState("");
  const [confirm, setConfirm] = useState({
    open: false,
    contact: null,
    deleting: false,
    error: "",
  });

  // saving state for tag operations
  const [savingTagIds, setSavingTagIds] = useState(new Set());

  // per-contact UI state
  const [openEditors, setOpenEditors] = useState(() => new Set()); // which contact IDs have the tag editor open
  const [showAllFor, setShowAllFor] = useState(() => new Set());   // which contact IDs show "all tags" vs template-only

  useEffect(() => {
    let mounted = true;
    (async () => {
      setLoading(true);

      // 1) Auth
      const { data: sessionData } = await supabase.auth.getSession();
      const uid = sessionData?.session?.user?.id || null;
      if (!uid) {
        setLoading(false);
        return;
      }

      // 2) Get global enabled flags
      const { data: mtRow, error: mtErr } = await supabase
        .from("message_templates")
        .select("enabled")
        .eq("user_id", uid)
        .maybeSingle();

      if (mtErr) {
        console.error("[Contacts] templates fetch error:", mtErr);
      }

      const initialEnabled =
        mtRow?.enabled && typeof mtRow.enabled === "object"
          ? { ...DEFAULT_ENABLED, ...mtRow.enabled }
          : { ...DEFAULT_ENABLED };
      if (!mounted) return;
      setEnabledMap(initialEnabled);

      // 3) Get contacts
      const { data: rows, error } = await supabase
        .from("message_contacts")
        .select("id, full_name, phone, tags, meta, created_at, subscribed")
        .eq("user_id", uid)
        .order("created_at", { ascending: false });

      if (!mounted) return;
      if (error) {
        console.error("[Contacts] fetch error:", error);
        setContacts([]);
      } else {
        const normalized = (rows || []).map((c) => ({
          ...c,
          tags: uniqueTags(c.tags || []),
        }));
        setContacts(normalized);
      }

      setLoading(false);
    })();

    return () => {
      mounted = false;
    };
  }, []);

  // Build a global union of all tags to support the "show all" palette
  const unionOfExistingTags = useMemo(() => {
    const set = new Set();
    for (const c of contacts) for (const t of c.tags || []) set.add(normalizeTag(t));
    return Array.from(set);
  }, [contacts]);

  // Full palette when "show all" is enabled
  const ALL_TAGS_FULL = useMemo(() => {
    const set = new Set([
      ...TEMPLATE_TAGS.map(normalizeTag),
      ...unionOfExistingTags,
      ...EXTRA_TAG_SUGGESTIONS.map(normalizeTag),
    ]);
    return Array.from(set).sort();
  }, [unionOfExistingTags]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return contacts;
    return contacts.filter((c) => {
      const tagsStr = Array.isArray(c.tags) ? c.tags.join(",").toLowerCase() : "";
      return (
        (c.full_name || "").toLowerCase().includes(s) ||
        (c.phone || "").toLowerCase().includes(s) ||
        tagsStr.includes(s)
      );
    });
  }, [contacts, q]);

  function openConfirm(contact) {
    setConfirm({ open: true, contact, deleting: false, error: "" });
  }
  function closeConfirm() {
    setConfirm({ open: false, contact: null, deleting: false, error: "" });
  }

  async function deleteContact() {
    if (!confirm.contact?.id) return;
    setConfirm((c) => ({ ...c, deleting: true, error: "" }));
    try {
      const { error } = await supabase
        .from("message_contacts")
        .delete()
        .eq("id", confirm.contact.id);
      if (error) throw error;
      setContacts((prev) => prev.filter((c) => c.id !== confirm.contact.id));
      closeConfirm();
    } catch (e) {
      setConfirm((c) => ({
        ...c,
        deleting: false,
        error: e.message || "Failed to delete.",
      }));
    }
  }

  /* ---------------- Tag editing ---------------- */
  async function addTag(contact, tag) {
    const contactId = contact.id;
    const norm = normalizeTag(tag);
    if (!norm) return;

    const nextTags = uniqueTags([...(contact.tags || []), norm]);
    if (nextTags.join(",") === (contact.tags || []).join(",")) return; // no change

    // optimistic UI
    setContacts((prev) =>
      prev.map((c) => (c.id === contactId ? { ...c, tags: nextTags } : c))
    );
    setSavingTagIds((s) => new Set(s).add(contactId));
    try {
      const { error } = await supabase
        .from("message_contacts")
        .update({ tags: nextTags })
        .eq("id", contactId);
      if (error) throw error;
    } catch (e) {
      // rollback
      setContacts((prev) =>
        prev.map((c) => (c.id === contactId ? { ...c, tags: contact.tags } : c))
      );
      alert(e.message || "Failed to add tag.");
    } finally {
      setSavingTagIds((s) => {
        const n = new Set(s);
        n.delete(contactId);
        return n;
      });
    }
  }

  async function removeTag(contact, tag) {
    const contactId = contact.id;
    const nextTags = (contact.tags || []).filter(
      (t) => normalizeTag(t) !== normalizeTag(tag)
    );

    // optimistic UI
    const prevTags = contact.tags || [];
    setContacts((prev) =>
      prev.map((c) => (c.id === contactId ? { ...c, tags: nextTags } : c))
    );
    setSavingTagIds((s) => new Set(s).add(contactId));
    try {
      const { error } = await supabase
        .from("message_contacts")
        .update({ tags: nextTags })
        .eq("id", contactId);
      if (error) throw error;
    } catch (e) {
      // rollback
      setContacts((prev) =>
        prev.map((c) => (c.id === contactId ? { ...c, tags: prevTags } : c))
      );
      alert(e.message || "Failed to remove tag.");
    } finally {
      setSavingTagIds((s) => {
        const n = new Set(s);
        n.delete(contactId);
        return n;
      });
    }
  }

  // toggle helpers
  function toggleEditor(contactId) {
    setOpenEditors((prev) => {
      const n = new Set(prev);
      if (n.has(contactId)) n.delete(contactId);
      else n.add(contactId);
      return n;
    });
  }
  function toggleShowAll(contactId) {
    setShowAllFor((prev) => {
      const n = new Set(prev);
      if (n.has(contactId)) n.delete(contactId);
      else n.add(contactId);
      return n;
    });
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <header className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-xl bg-white/5 ring-1 ring-white/10">
            <MessageSquare className="h-5 w-5" />
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-lg font-semibold">Contacts on Messaging List</h1>
            <p className="text-sm text-white/70">
              Manage tags per contact. Click “Manage tags” to open the editor. By default the palette
              shows only template-related tags; you can toggle to show all tags.
            </p>
          </div>
        </div>
      </header>

      {/* Top actions / search */}
      <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-3 py-2">
            <Search className="h-4 w-4 text-white/60" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search name, phone, or tag…"
              className="w-64 bg-transparent text-sm outline-none placeholder:text-white/40"
            />
          </div>

          <div className="text-xs text-white/60">
            <span className="inline-flex items-center gap-1">
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-300" />
              <span>Enabled templates:</span>
            </span>
            <span className="ml-2">
              {TEMPLATE_DEFS.filter((t) => enabledMap[t.key]).length === 0 ? (
                <span className="text-white/50">None</span>
              ) : (
                TEMPLATE_DEFS.filter((t) => enabledMap[t.key])
                  .map((t) => t.label)
                  .join(", ")
              )}
            </span>
          </div>
        </div>
      </section>

      {/* Table */}
      <section className="rounded-2xl border border-white/10 bg-white/[0.02]">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="sticky top-0 bg-black/30 backdrop-blur border-b border-white/10">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-white/70">Name</th>
                <th className="px-4 py-3 text-left font-medium text-white/70">Phone</th>
                <th className="px-4 py-3 text-left font-medium text-white/70">Tags</th>
                <th className="px-4 py-3 text-left font-medium text-white/70">Eligible (by tags)</th>
                <th className="px-4 py-3 text-left font-medium text-white/70">Subscribed</th>
                <th className="px-4 py-3 text-right font-medium text-white/70">Actions</th>
              </tr>
            </thead>

            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-white/70">
                    <div className="inline-flex items-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Loading…
                    </div>
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-white/60">
                    No contacts found.
                  </td>
                </tr>
              ) : (
                filtered.map((c) => {
                  const eligible = eligibleTemplatesForContact(c, enabledMap);
                  const saving = savingTagIds.has(c.id);
                  const has = new Set((c.tags || []).map(normalizeTag));
                  const editorOpen = openEditors.has(c.id);
                  const showAll = showAllFor.has(c.id);
                  const palette = showAll ? ALL_TAGS_FULL : TEMPLATE_TAGS;

                  return (
                    <tr key={c.id} className="border-b border-white/5 hover:bg-white/[0.03]">
                      <td className="px-4 py-3">
                        <div className="font-medium">{c.full_name || "—"}</div>
                        <div className="text-xs text-white/50">
                          {new Date(c.created_at).toLocaleString()}
                        </div>
                      </td>

                      <td className="px-4 py-3">{c.phone || "—"}</td>

                      {/* Tags column */}
                      <td className="px-4 py-3">
                        {/* Current tags (compact, always visible) */}
                        <div className="mb-2 flex flex-wrap items-center gap-1">
                          {Array.isArray(c.tags) && c.tags.length > 0 ? (
                            c.tags.map((t) => (
                              <span
                                key={t}
                                className="inline-flex items-center gap-1 rounded-full bg-white/5 px-2 py-0.5 text-[11px] text-white/70 ring-1 ring-white/10"
                              >
                                {t}
                                <button
                                  onClick={() => removeTag(c, t)}
                                  className="ml-1 rounded hover:bg-white/10 p-0.5"
                                  title="Remove tag"
                                  disabled={saving}
                                >
                                  <X className="h-3 w-3 opacity-70" />
                                </button>
                              </span>
                            ))
                          ) : (
                            <span className="text-white/50">—</span>
                          )}
                        </div>

                        {/* Toggle editor open/close */}
                        <button
                          onClick={() => toggleEditor(c.id)}
                          className="inline-flex items-center gap-1 rounded-lg border border-white/15 bg-white/5 px-2 py-1 text-[11px] hover:bg-white/10"
                        >
                          <ChevronsUpDown className="h-3.5 w-3.5" />
                          {editorOpen ? "Hide tag editor" : "Manage tags"}
                        </button>

                        {/* Collapsible tag editor */}
                        {editorOpen && (
                          <div className="mt-2 rounded-lg border border-white/10 bg-white/[0.03] p-2">
                            <div className="mb-1 flex items-center justify-between">
                              <div className="text-[11px] text-white/50">
                                {showAll ? "All tags" : "Template-related tags"}
                              </div>
                              <label className="flex items-center gap-2 text-[11px] text-white/60 select-none">
                                <input
                                  type="checkbox"
                                  className="h-3 w-3 accent-white/80"
                                  checked={showAll}
                                  onChange={() => toggleShowAll(c.id)}
                                />
                                Show all tags
                              </label>
                            </div>

                            <div className="flex flex-wrap gap-1 max-h-28 overflow-y-auto pr-1">
                              {palette.map((t) => {
                                const active = has.has(normalizeTag(t));
                                return (
                                  <span
                                    key={t}
                                    className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] ring-1 ${
                                      active
                                        ? "bg-emerald-500/10 text-emerald-300 ring-emerald-400/20"
                                        : "bg-white/5 text-white/70 ring-white/10"
                                    }`}
                                  >
                                    {t}
                                    <button
                                      onClick={() =>
                                        active ? removeTag(c, t) : addTag(c, t)
                                      }
                                      className="ml-1 rounded hover:bg-white/10 p-0.5 disabled:opacity-50"
                                      title={active ? "Remove tag" : "Add tag"}
                                      disabled={saving}
                                    >
                                      {active ? (
                                        <Minus className="h-3 w-3" />
                                      ) : (
                                        <Plus className="h-3 w-3" />
                                      )}
                                    </button>
                                  </span>
                                );
                              })}
                            </div>
                          </div>
                        )}
                      </td>

                      {/* Eligible templates display */}
                      <td className="px-4 py-3">
                        {c.subscribed ? (
                          eligible.length === 0 ? (
                            <span className="text-white/50">None</span>
                          ) : (
                            <div className="flex flex-wrap gap-1">
                              {eligible.map((e) => (
                                <span
                                  key={e.key}
                                  className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-300 ring-1 ring-emerald-400/20"
                                >
                                  {e.label}
                                </span>
                              ))}
                            </div>
                          )
                        ) : (
                          <span className="text-white/50">Unsubscribed</span>
                        )}
                      </td>

                      {/* Subscribed */}
                      <td className="px-4 py-3">
                        {c.subscribed ? (
                          <span className="text-emerald-300">Yes</span>
                        ) : (
                          <span className="text-white/50">No</span>
                        )}
                      </td>

                      {/* Actions */}
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => openConfirm(c)}
                          className="inline-flex items-center gap-1 rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-xs hover:bg-white/10"
                          title="Delete contact (stop future messages)"
                        >
                          <Trash2 className="h-4 w-4" />
                          Delete
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Confirm delete modal */}
      {confirm.open && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4"
          onClick={closeConfirm}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-white/10 bg-[#0b0b12] p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center gap-2">
              <MessageSquare className="h-5 w-5 text-amber-300" />
              <h2 className="text-sm font-semibold">Delete contact?</h2>
            </div>
            <p className="text-sm text-white/70">
              This will remove{" "}
              <span className="font-medium">
                {confirm.contact?.full_name || confirm.contact?.phone}
              </span>{" "}
              from your messaging list so they won’t receive future automated messages.
              This action cannot be undone.
            </p>

            {confirm.error && (
              <div className="mt-3 rounded-lg border border-rose-400/30 bg-rose-500/10 p-2 text-xs text-rose-200">
                {confirm.error}
              </div>
            )}

            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                onClick={closeConfirm}
                disabled={confirm.deleting}
                className="rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-xs hover:bg-white/10 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={deleteContact}
                disabled={confirm.deleting}
                className="inline-flex items-center gap-2 rounded-lg border border-rose-400/30 bg-rose-500/15 px-3 py-1.5 text-xs text-rose-200 hover:bg-rose-500/25 disabled:opacity-50"
              >
                {confirm.deleting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> Deleting…
                  </>
                ) : (
                  <>
                    <Trash2 className="h-4 w-4" /> Delete contact
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
