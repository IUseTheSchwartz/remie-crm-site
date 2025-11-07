// File: src/components/admin/PhoneNumberPoolAdminSection.jsx
import NumberPool10DLC from "./NumberPool10DLC.jsx";

/**
 * Thin wrapper to keep older imports working.
 * Renders the 10DLC pool admin UI.
 */
export default function PhoneNumberPoolAdminSection() {
  return (
    <div className="space-y-4">
      <NumberPool10DLC />
    </div>
  );
}
