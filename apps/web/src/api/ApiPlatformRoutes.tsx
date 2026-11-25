import { lazy, Suspense } from "react";
import { Navigate, Route } from "react-router-dom";
import { Skeleton } from "../components/ui/Skeleton";

// The platform console (slice P2 of apps/api/docs/PLATFORM-CONSOLE.md) loads only when Figbloom staff open it.
const ApiPlatformShell = lazy(() => import("./ApiPlatform").then((m) => ({ default: m.ApiPlatformShell })));

const fallback = (
  <div className="mx-auto max-w-2xl space-y-3 p-8">
    <Skeleton className="h-8 w-64" />
    <Skeleton className="h-40 w-full" />
  </div>
);

/** The platform console's routes, for ApiApp's route list (kept here so ApiApp changes by one line). */
export const platformRoutes = [
  <Route key="platform-root" path="/platform" element={<Navigate to="/platform/tenants" replace />} />,
  <Route key="platform-page" path="/platform/:page" element={<Suspense fallback={fallback}><ApiPlatformShell /></Suspense>} />,
];
