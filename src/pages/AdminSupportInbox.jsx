// File: src/pages/AdminSupportInbox.jsx
import ProtectedRoute from "../components/ProtectedRoute.jsx";
import SupportInbox from "./SupportInbox.jsx";

export default function AdminSupportInbox() {
  return (
    <ProtectedRoute requireAdmin>
      <SupportInbox />
    </ProtectedRoute>
  );
}
