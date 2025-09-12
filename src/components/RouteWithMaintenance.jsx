// File: src/components/RouteWithMaintenance.jsx
import { useAuth } from "../auth.jsx";
import { pageToggles, ownerEmail } from "../pagesConfig.js";

export default function RouteWithMaintenance({ pageKey, Component }) {
  const { user } = useAuth?.() || { user: null };
  const isOwner =
    (user?.email || "").toLowerCase() === (ownerEmail || "").toLowerCase();
  const blocked = !!pageToggles?.[pageKey];

  if (blocked && !isOwner) {
    return (
      <div className="grid min-h-[60vh] place-items-center p-8">
        <div className="max-w-md text-center">
          <div className="mb-4 text-3xl">🚧</div>
          <h2 className="mb-2 text-xl font-semibold">Under maintenance</h2>
          <p className="text-sm text-white/70">
            This page is temporarily unavailable while we make improvements.
            Please check back soon.
          </p>
        </div>
      </div>
    );
  }

  return <Component />;
}
