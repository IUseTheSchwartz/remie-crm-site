// File: src/components/MaintenanceGate.jsx
import { useAuth } from "../auth.jsx";
import { pageToggles } from "../pagesConfig.js";

export default function MaintenanceGate({ pageName, children }) {
  const { user } = useAuth();

  // If page is marked true (maintenance) and user is not Jacob → block
  if (pageToggles[pageName] && user?.email !== "jacobprieto@gmail.com") {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-red-500 mb-2">
            🚧 Under Maintenance
          </h1>
          <p className="text-gray-400">This page is temporarily unavailable.</p>
        </div>
      </div>
    );
  }

  // Otherwise, render the real page
  return children;
}
