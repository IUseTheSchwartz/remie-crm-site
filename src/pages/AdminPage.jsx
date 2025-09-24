// src/pages/AdminPage.jsx
import useIsAdminAllowlist from "../hooks/useIsAdminAllowlist.js";

export default function AdminPage() {
  const { isAdmin, loading } = useIsAdminAllowlist();

  if (loading) return <div>Loading…</div>;
  if (!isAdmin) return <div>Access denied</div>;

  return (
    <div className="p-6">
      <h1 className="text-2xl font-semibold mb-4">Admin Console</h1>

      {/* Example: manage balances */}
      <section className="mb-6">
        <h2 className="text-lg font-medium">Balances</h2>
        {/* table of users with edit option */}
      </section>

      {/* Example: manage seats */}
      <section className="mb-6">
        <h2 className="text-lg font-medium">Seats</h2>
        {/* table of users with seat counts */}
      </section>

      {/* Example: toggle templates */}
      <section>
        <h2 className="text-lg font-medium">Templates</h2>
        {/* checkboxes/switches to disable or enable templates */}
      </section>
    </div>
  );
}
