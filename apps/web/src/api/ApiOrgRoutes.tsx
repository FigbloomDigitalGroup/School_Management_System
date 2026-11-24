import { lazy, Suspense } from "react";
import { Route } from "react-router-dom";
import { Skeleton } from "../components/ui/Skeleton";

// The organisation console (S11) loads when an org admin opens it.
const ApiOrgRoutes = lazy(() => import("./ApiOrg").then((m) => ({ default: m.ApiOrgRoutes })));
const ApiOrgPicker = lazy(() => import("./ApiOrg").then((m) => ({ default: m.ApiOrgPicker })));

const fallback = <div className="mx-auto max-w-2xl space-y-3 p-8"><Skeleton className="h-8 w-64" /><Skeleton className="h-40 w-full" /></div>;

/** The organisation console's two addresses, for ApiApp's route list (kept here so ApiApp changes by one line). */
export const orgRoutes = [
  <Route key="org-picker" path="/org-picker" element={<Suspense fallback={fallback}><ApiOrgPicker /></Suspense>} />,
  <Route key="org" path="/org/:orgSlug/*" element={<Suspense fallback={fallback}><ApiOrgRoutes /></Suspense>} />,
];
