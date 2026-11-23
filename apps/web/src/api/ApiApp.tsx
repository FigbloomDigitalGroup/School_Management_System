import { Navigate, Route, Routes } from "react-router-dom";
import { ApiSchool } from "./ApiHome";
import { ApiSignIn } from "./ApiSignIn";

/**
 * The web app on a build made for the new API (VITE_BACKEND=api, FIG-1890). It is deliberately not the Supabase app with
 * a switch inside: every screen of that one still reads the database directly, so on this build they would fail one by
 * one. This has only what runs on the API today, and grows as each area is ported (src/api/ is where they are added).
 */
export function ApiApp() {
  return (
    <Routes>
      <Route path="/signin" element={<ApiSignIn />} />
      <Route path="/s/:slug/*" element={<ApiSchool />} />
      <Route path="*" element={<Navigate to="/signin" replace />} />
    </Routes>
  );
}
