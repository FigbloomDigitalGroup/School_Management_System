import { Navigate, Route, Routes } from "react-router-dom";
import { ConfirmHost } from "../components/ui/Confirm";
import { ToastHost } from "../components/ui/Toast";
import { ApiAcceptInvite } from "./ApiAcceptInvite";
import { ApiSchool } from "./ApiHome";
import { ApiForgotPassword, ApiResetPassword } from "./ApiPasswordReset";
import { ApiSessionGuard } from "./ApiSessionGuard";
import { ApiSignIn } from "./ApiSignIn";
import { orgRoutes } from "./ApiOrgRoutes";
import { platformRoutes } from "./ApiPlatformRoutes";

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
          {/* Account e-mails link here (apps/api resendNotifier.ts). */}
          <Route path="/forgot-password" element={<ApiForgotPassword />} />
          <Route path="/reset-password" element={<ApiResetPassword />} />
          <Route path="/s/:slug/*" element={<ApiSchool />} />
          {orgRoutes}
          {platformRoutes}
          <Route path="*" element={<Navigate to="/signin" replace />} />
        </Routes>
      </ApiSessionGuard>
    </ToastHost>
  );
}
