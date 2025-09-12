// components/MaintenanceGate.jsx
import { useAuth } from "../auth.jsx";

/**
 * MaintenanceGate
 * Wrap any page with this. When `enabled` is true, only `ownerEmail` sees the content.
 * Everyone else sees an "Under maintenance" placeholder.
 */
export default function MaintenanceGate({ enabled = false, ownerEmail = "jacobprieto@gmail.com", children, fallback }) {
  const { user } = useAuth?.() || { user: null };
  const isOwner = (user?.email || "").toLowerCase() === (ownerEmail || "").toLowerCase();

  if (!enabled || isOwner) return children;

  return (
    fallback || (
      <div className="grid min-h-[60vh] place-items-center p-8">
        <div className="max-w-md text-center">
          <div className="mb-4 text-3xl">🚧</div>
          <h2 className="mb-2 text-xl font-semibold">Under maintenance</h2>
          <p className="text-sm text-white/70">
            This page is temporarily unavailable while we make improvements. Please check back soon.
          </p>
        </div>
      </div>
    )
  );
}

// ----------------------------------------
// src/pages/LeadsPage.jsx (updated)
// ----------------------------------------
import MaintenanceGate from "../components/MaintenanceGate.jsx";
const LEADS_UNDER_MAINTENANCE = false; // set true to hide from everyone except jacobprieto@gmail.com

// (rest of file remains the same until the default export)
// ...
export default function LeadsPage() {
  // (existing hooks/state/effects above stay untouched)
  // ...
  return (
    <MaintenanceGate enabled={LEADS_UNDER_MAINTENANCE} ownerEmail="jacobprieto@gmail.com">
      {/* ORIGINAL RETURN CONTENT STARTS HERE */}
      <div className="space-y-6 min-w-0 overflow-x-hidden">
        {/* Toolbar */}
        {/* ... full original JSX ... */}
      </div>
      {/* ORIGINAL RETURN CONTENT ENDS HERE */}
    </MaintenanceGate>
  );
}

// ----------------------------------------
// src/pages/PipelinePage.jsx (updated)
// ----------------------------------------
import MaintenanceGate from "../components/MaintenanceGate.jsx";
const PIPELINE_UNDER_MAINTENANCE = false; // toggle true to hide from non-owner users

export default function PipelinePage() {
  // (existing hooks/state/effects)
  // ...
  return (
    <MaintenanceGate enabled={PIPELINE_UNDER_MAINTENANCE} ownerEmail="jacobprieto@gmail.com">
      {/* ORIGINAL RETURN CONTENT STARTS HERE */}
      <div className="space-y-4">
        {/* ... full original JSX ... */}
      </div>
      {/* ORIGINAL RETURN CONTENT ENDS HERE */}
    </MaintenanceGate>
  );
}

// ----------------------------------------
// src/pages/CalendarPage.jsx (updated)
// ----------------------------------------
import MaintenanceGate from "../components/MaintenanceGate.jsx";
const CALENDAR_UNDER_MAINTENANCE = false;

export default function CalendarPage() {
  return (
    <MaintenanceGate enabled={CALENDAR_UNDER_MAINTENANCE} ownerEmail="jacobprieto@gmail.com">
      {/* ORIGINAL RETURN CONTENT STARTS HERE */}
      <div className="p-2">
        {/* ... full original JSX ... */}
      </div>
      {/* ORIGINAL RETURN CONTENT ENDS HERE */}
    </MaintenanceGate>
  );
}

// ----------------------------------------
// src/pages/ReportsPage.jsx (updated)
// ----------------------------------------
import MaintenanceGate from "../components/MaintenanceGate.jsx";
const REPORTS_UNDER_MAINTENANCE = false;

export default function ReportsPage() {
  // existing logic ...
  if (loading) return <div className="p-6">Loading…</div>;
  return (
    <MaintenanceGate enabled={REPORTS_UNDER_MAINTENANCE} ownerEmail="jacobprieto@gmail.com">
      {/* ORIGINAL RETURN CONTENT STARTS HERE */}
      <div className="space-y-6">
        {/* ... full original JSX ... */}
      </div>
      {/* ORIGINAL RETURN CONTENT ENDS HERE */}
    </MaintenanceGate>
  );
}

// ----------------------------------------
// src/pages/Settings.jsx (updated)
// ----------------------------------------
import MaintenanceGate from "../components/MaintenanceGate.jsx";
const SETTINGS_UNDER_MAINTENANCE = false;

export default function Settings() {
  // existing logic ...
  return (
    <MaintenanceGate enabled={SETTINGS_UNDER_MAINTENANCE} ownerEmail="jacobprieto@gmail.com">
      {/* ORIGINAL RETURN CONTENT STARTS HERE */}
      <div className="max-w-3xl mx-auto p-6">
        {/* ... full original JSX ... */}
      </div>
      {/* ORIGINAL RETURN CONTENT ENDS HERE */}
    </MaintenanceGate>
  );
}

// ----------------------------------------
// src/pages/ContactsPage.jsx (updated)
// ----------------------------------------
import MaintenanceGate from "../components/MaintenanceGate.jsx";
const CONTACTS_UNDER_MAINTENANCE = false;

export default function ContactsPage() {
  // existing logic ...
  return (
    <MaintenanceGate enabled={CONTACTS_UNDER_MAINTENANCE} ownerEmail="jacobprieto@gmail.com">
      {/* ORIGINAL RETURN CONTENT STARTS HERE */}
      <div className="space-y-6">
        {/* ... full original JSX ... */}
      </div>
      {/* ORIGINAL RETURN CONTENT ENDS HERE */}
    </MaintenanceGate>
  );
}
