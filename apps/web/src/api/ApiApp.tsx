import { Navigate, Route, Routes } from "react-router-dom";
import { ConfirmHost } from "../components/ui/Confirm";
import { ToastHost } from "../components/ui/Toast";
import { ApiAcceptInvite } from "./ApiAcceptInvite";
import { ApiSchool } from "./ApiHome";
import { ApiSessionGuard } from "./ApiSessionGuard";
import { ApiSignIn } from "./ApiSignIn";

/**
 * The web app on a build made for the new API (VITE_BACKEND=api, FIG-1890). It is deliberately not the Supabase app with
 * a switch inside: most screens of that one still read the database directly, so on this build they would fail one by one.
 * This has only what runs on the API today (src/api/ApiConsole.tsx lists the admin pages), and grows as each area is ported.
 */
export function ApiApp() {
  return (
    <ToastHost>
      <ConfirmHost />
      <ApiSessionGuard>
        <Routes>
          <Route path="/signin" element={<ApiSignIn />} />
          <Route path="/accept-invite" element={<ApiAcceptInvite />} />
          <Route path="/invite" element={<ApiAcceptInvite />} />
          <Route path="/s/:slug/*" element={<ApiSchool />} />
          <Route path="*" element={<Navigate to="/signin" replace />} />
        </Routes>
      </ApiSessionGuard>
    </ToastHost>
  );
}
