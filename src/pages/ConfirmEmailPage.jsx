// File: src/pages/ConfirmEmailPage.jsx
import { Link } from "react-router-dom";
import Logo from "../assets/logo-tight.png";

const BRAND = {
  name: "Remie CRM",
  primary: "from-indigo-500 via-purple-500 to-fuchsia-500",
};

export default function ConfirmEmailPage() {
  return (
    <div className="min-h-screen grid place-items-center bg-neutral-950 text-white px-6">
      <div className="w-full max-w-md rounded-3xl border border-white/10 bg-white/[0.03] p-6 ring-1 ring-white/5">
        <div className="mb-4 flex items-center gap-3">
          <div className="grid h-9 w-9 place-items-center">
            <img src={Logo} alt="Logo" className="h-9 w-9 object-contain" />
          </div>
          <div className="text-lg font-semibold">{BRAND.name}</div>
        </div>

        <h1 className="text-2xl font-semibold">Email confirmed 🎉</h1>
        <p className="mt-2 text-sm text-white/70">
          Thanks for confirming your email.
          You can now log in and start using your workspace.
        </p>

        <Link
          to="/login"
          className="mt-6 inline-flex w-full items-center justify-center rounded-xl bg-white px-4 py-2.5 text-sm font-semibold text-neutral-900 shadow-sm hover:bg-neutral-100 transition"
        >
          Go to login
        </Link>

        <p className="mt-4 text-xs text-white/50">
          If this wasn&apos;t you, you can ignore this email and your account will remain inactive.
        </p>
      </div>
    </div>
  );
}
