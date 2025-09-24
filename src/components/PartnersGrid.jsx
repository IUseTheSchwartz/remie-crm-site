import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient.js";
import { Instagram } from "lucide-react";

function IGLink({ handle }) {
  if (!handle) return null;
  const clean = handle.startsWith("@") ? handle.slice(1) : handle;
  const href = `https://instagram.com/${clean}`;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-2 text-sm font-medium text-indigo-600 hover:opacity-80"
    >
      <Instagram className="h-4 w-4" />
      @{clean}
    </a>
  );
}

export default function PartnersGrid() {
  const [partners, setPartners] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      setLoading(true);
      const { data, error } = await supabase
        .from("partners")
        .select("*")
        .eq("active", true)
        .order("sort_order", { ascending: true, nullsFirst: true })
        .order("name", { ascending: true });
      if (!error) setPartners(data || []);
      setLoading(false);
    }
    load();
  }, []);

  if (loading) {
    return <div className="text-center py-10 text-zinc-500">Loading partners…</div>;
  }

  if (!partners.length) {
    return <div className="text-center py-10 text-zinc-500">No partners yet.</div>;
  }

  return (
    <section className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 mt-16">
      <header className="text-center mb-10">
        <h2 className="text-3xl font-semibold">Meet Our Partners</h2>
        <p className="mt-2 text-zinc-600 max-w-2xl mx-auto">
          We partner with top producers, influencers, and leaders who share our standards.
        </p>
      </header>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
        {partners.map((p) => (
          <article
            key={p.id}
            className="rounded-2xl border border-zinc-200 bg-white shadow-sm hover:shadow-md transition overflow-hidden"
          >
            <div className="p-5">
              <div className="flex items-start gap-4">
                <img
                  src={p.photo_url || "/assets/partners/placeholder-avatar.png"}
                  alt={`${p.name} headshot`}
                  className="h-16 w-16 rounded-xl object-cover ring-1 ring-zinc-200"
                  loading="lazy"
                />
                <div className="min-w-0">
                  <h3 className="text-lg font-semibold truncate">{p.name}</h3>
                  <p className="text-sm text-zinc-600">{p.role}</p>
                </div>
              </div>

              {p.bio && (
                <p className="mt-4 text-sm leading-relaxed text-zinc-700">{p.bio}</p>
              )}

              <div className="mt-5">
                <IGLink handle={p.instagram_handle} />
              </div>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
