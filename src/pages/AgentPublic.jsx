import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { supabase } from "../lib/supabaseClient";
import { ExternalLink, Phone, Mail, Shield } from "lucide-react";

/** Optional: external regulator lookups you can expand over time */
const REGULATOR_LINKS = {
  AL: "https://aldoi.gov/",
  AK: "https://www.commerce.alaska.gov/web/ins/",
  AZ: "https://insurance.az.gov/",
  AR: "https://insurance.arkansas.gov/",
  CA: "https://www.insurance.ca.gov/0200-industry/0008-education-provider/producer-licensing.cfm",
  CO: "https://doi.colorado.gov/insurance-products/producers",
  CT: "https://portal.ct.gov/cid",
  DE: "https://insurance.delaware.gov/",
  FL: "https://licenseesearch.fldfs.com/",
  GA: "https://oci.georgia.gov/insurance-resources/agent-individual-agency-company-search",
  HI: "https://cca.hawaii.gov/ins/insurance-license-search/",
  ID: "https://doi.idaho.gov/industry/licensing-services/",
  IL: "https://www.ilsos.gov/ilbp/ilbp",
  IN: "https://www.in.gov/idoi/licensing/",
  IA: "https://iid.iowa.gov/find-a-licensed-agent",
  KS: "https://sbs.naic.org/solar-external-lookup/license-manager",
  KY: "https://insurance.ky.gov/ppc/new_default.aspx",
  LA: "https://www.ldi.la.gov/onlineservices/ProducerAdjusterSearch/",
  ME: "https://www.maine.gov/pfr/insurance/licensees/individual",
  MD: "https://insurance.maryland.gov/Pages/default.aspx",
  MA: "https://www.mass.gov/insurance-providers-and-producers",
  MI: "https://difs.state.mi.us/locators?searchtype=InsAgent",
  MN: "https://mn.gov/commerce/licensing/license-lookup/",
  MS: "https://www.mid.ms.gov/licensing-search/licensing-search.aspx",
  MO: "https://insurance.mo.gov/CompanyAgentSearch/search/search-agents.php",
  MT: "https://csimt.gov/insurance/licensing/",
  NE: "https://doi.nebraska.gov/consumer/company-and-producer-search",
  NV: "https://di.nv.gov/ins/f?p=licensing:search",
  NH: "https://www.insurance.nh.gov/",
  NJ: "https://www-dobi.state.nj.us/DOBI_LicSearch/",
  NM: "https://www.osi.state.nm.us/",
  NY: "https://www.dfs.ny.gov/apps_and_licensing/agents_and_brokers/home",
  NC: "https://www.ncdoi.gov/licensees/insurance-producer-and-adjuster-licensing",
  ND: "https://www.insurance.nd.gov/producers",
  OH: "https://gateway.insurance.ohio.gov/UI/ODI.Agent.Public.UI/AgentSearch.mvc/DisplaySearch",
  OK: "https://www.oid.ok.gov/licensing-and-education/licensee-look-up/",
  OR: "https://dfr.oregon.gov/help/complaints-licenses/pages/check-license.aspx",
  PA: "https://apps02.ins.pa.gov/producer/ilist1.asp",
  RI: "https://dbr.ri.gov/insurance/insurance-professionals",
  SC: "https://doi.sc.gov/354/Licensing-CE",
  SD: "https://dlr.sd.gov/insurance/license_inquiry_service.aspx",
  TN: "https://www.tn.gov/commerce/insurance.html",
  TX: "https://txapps.texas.gov/NASApp/tdi/TdiARManager",
  UT: "https://insurance.utah.gov/",
  VT: "https://dfr.vermont.gov/insurance",
  VA: "https://www.scc.virginia.gov/",
  WA: "https://fortress.wa.gov/oic/consumertoolkit/Search.aspx",
  WV: "https://www.wvinsurance.gov/Divisions_Licensing",
  WI: "https://oci.wi.gov/Pages/Consumers/Look-Up.aspx",
  WY: "https://doi.wyo.gov/licensing",
};

/** Pretty names for state codes */
const STATE_NAMES = new Intl.DisplayNames(["en-US"], { type: "region" });

export default function AgentPublic() {
  const { slug } = useParams();
  const [profile, setProfile] = useState(null);
  const [states, setStates] = useState([]);
  const [loading, setLoading] = useState(true);

  // fetch profile + states by slug
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        // 1) get the profile by slug (including user_id so we can look up states)
        const { data: prof, error: e1 } = await supabase
          .from("agent_profiles")
          .select("user_id, full_name, email, phone, short_bio, headshot_url, published, slug")
          .eq("slug", slug)
          .maybeSingle();
        if (e1) throw e1;
        if (!prof) {
          if (mounted) setProfile(null);
          return;
        }

        // 2) get state rows for that user_id
        const { data: st, error: e2 } = await supabase
          .from("agent_states")
          .select("state_code, license_number, license_image_url")
          .eq("user_id", prof.user_id);
        if (e2) throw e2;

        if (mounted) {
          setProfile(prof);
          setStates(st || []);
        }
      } catch (err) {
        console.error(err);
        if (mounted) {
          setProfile(null);
          setStates([]);
        }
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [slug]);

  const hasStates = states && states.length > 0;

  if (loading) {
    return (
      <div className="min-h-screen bg-neutral-950 text-white grid place-items-center">
        <div className="text-white/70">Loading…</div>
      </div>
    );
    }
  if (!profile) {
    return (
      <div className="min-h-screen bg-neutral-950 text-white grid place-items-center">
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-6">
          <div className="text-lg font-semibold">Page not found</div>
          <div className="mt-1 text-sm text-white/70">This agent page does not exist or is unpublished.</div>
        </div>
      </div>
    );
  }

  const heroGradient =
    "bg-gradient-to-br from-indigo-600/20 via-fuchsia-500/10 to-rose-500/10";

  const callHref = useMemo(() => (profile.phone ? `tel:${profile.phone.replace(/[^\d+]/g, "")}` : null), [profile.phone]);
  const mailHref = useMemo(() => (profile.email ? `mailto:${profile.email}` : null), [profile.email]);

  return (
    <div className="min-h-screen bg-neutral-950 text-white">
      {/* Top bar */}
      <header className="sticky top-0 z-30 border-b border-white/10 bg-black/60 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2">
            <div className={`h-8 w-8 rounded-2xl ring-1 ring-white/10 grid place-items-center ${heroGradient}`}>
              <Shield className="h-4 w-4" />
            </div>
            <div className="text-sm font-semibold tracking-tight">{profile.full_name}</div>
          </div>
          <nav className="flex items-center gap-4 text-xs text-white/70">
            <a href="#overview" className="hover:text-white">Overview</a>
            <a href="#licenses" className="hover:text-white">Licenses</a>
            <a href="#contact" className="hover:text-white">Contact</a>
          </nav>
        </div>
      </header>

      {/* Hero */}
      <section id="overview" className="relative">
        <div className={`absolute inset-0 ${heroGradient} blur-3xl`} />
        <div className="relative mx-auto grid max-w-6xl gap-6 px-4 py-10 md:grid-cols-[220px_1fr]">
          <div className="flex items-start justify-center md:justify-start">
            <div className="relative h-40 w-40 overflow-hidden rounded-2xl border border-white/10 bg-white/5 ring-1 ring-white/10">
              {profile.headshot_url ? (
                <img
                  src={profile.headshot_url}
                  alt={profile.full_name}
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="grid h-full w-full place-items-center text-white/50 text-xs">
                  No photo
                </div>
              )}
            </div>
          </div>

          <div className="space-y-3">
            <h1 className="text-3xl font-semibold tracking-tight">{profile.full_name}</h1>
            {profile.short_bio && (
              <p className="text-white/70 max-w-2xl">{profile.short_bio}</p>
            )}

            <div className="flex flex-wrap gap-3 pt-2">
              {callHref && (
                <a
                  href={callHref}
                  className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-sm hover:bg-white/10"
                >
                  <Phone className="h-4 w-4" />
                  Call
                </a>
              )}
              {mailHref && (
                <a
                  href={mailHref}
                  className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-sm hover:bg-white/10"
                >
                  <Mail className="h-4 w-4" />
                  Email
                </a>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* Licenses */}
      <section id="licenses" className="mx-auto max-w-6xl px-4 pb-12">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Licensed States</h2>
          <div className="text-xs text-white/50">
            Documents are provided by the agent’s state(s).
          </div>
        </div>

        {!hasStates ? (
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 text-sm text-white/70">
            No licenses posted yet.
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {states
              .sort((a, b) => a.state_code.localeCompare(b.state_code))
              .map((s) => {
                const isPdf = (s.license_image_url || "").toLowerCase().endsWith(".pdf");
                const niceName =
                  (STATE_NAMES && STATE_NAMES.of?.(`US-${s.state_code}`)) ||
                  (STATE_NAMES && STATE_NAMES.of?.(s.state_code)) ||
                  s.state_code;

                const verifyHref = REGULATOR_LINKS[s.state_code];

                return (
                  <div
                    key={s.state_code}
                    className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 ring-1 ring-white/5"
                  >
                    <div className="flex items-center justify-between">
                      <div className="text-sm font-medium">
                        {niceName} <span className="text-white/50">({s.state_code})</span>
                      </div>
                      {verifyHref && (
                        <a
                          href={verifyHref}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs text-indigo-300 hover:underline inline-flex items-center gap-1"
                          title="Verify with the state"
                        >
                          Verify <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                    </div>

                    <div className="mt-2 text-xs text-white/70">
                      License #: <span className="text-white">{s.license_number || "—"}</span>
                    </div>

                    {s.license_image_url ? (
                      isPdf ? (
                        <a
                          href={s.license_image_url}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-3 inline-flex items-center gap-2 rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-xs hover:bg-white/10"
                        >
                          View License PDF <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      ) : (
                        <div className="mt-3 overflow-hidden rounded-lg border border-white/10 bg-black/20">
                          <img
                            src={s.license_image_url}
                            alt={`${s.state_code} license`}
                            className="h-36 w-full object-cover"
                          />
                          <div className="p-2 text-[11px] text-white/60">License image</div>
                        </div>
                      )
                    ) : (
                      <div className="mt-3 grid h-24 place-items-center rounded-lg border border-dashed border-white/15 text-xs text-white/50">
                        No document uploaded
                      </div>
                    )}
                  </div>
                );
              })}
          </div>
        )}
      </section>

      {/* Contact */}
      <section id="contact" className="border-t border-white/10 bg-black/40">
        <div className="mx-auto max-w-6xl px-4 py-10">
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
            <h3 className="text-base font-semibold">Contact</h3>
            <div className="mt-2 text-sm text-white/70">
              Have questions about coverage options or scheduling a call?
            </div>
            <div className="mt-4 flex flex-wrap gap-3">
              {callHref && (
                <a
                  href={callHref}
                  className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-sm hover:bg-white/10"
                >
                  <Phone className="h-4 w-4" /> Call
                </a>
              )}
              {mailHref && (
                <a
                  href={mailHref}
                  className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-sm hover:bg-white/10"
                >
                  <Mail className="h-4 w-4" /> Email
                </a>
              )}
            </div>
          </div>
          <div className="mt-6 text-center text-[11px] text-white/50">
            © {new Date().getFullYear()} Remie CRM — Agent page
          </div>
        </div>
      </section>
    </div>
  );
}
