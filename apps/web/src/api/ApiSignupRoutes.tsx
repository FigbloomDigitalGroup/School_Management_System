import { lazy, Suspense } from "react";
import { Route } from "react-router-dom";
import { Skeleton } from "../components/ui/Skeleton";

// The two public sign-up screens load only when someone follows a "Get started" link or the e-mailed confirmation link.
const ApiSignup = lazy(() => import("./ApiSignup").then((m) => ({ default: m.ApiSignup })));
const ApiSignupVerify = lazy(() => import("./ApiSignup").then((m) => ({ default: m.ApiSignupVerify })));

const fallback = (
  <div className="mx-auto max-w-2xl space-y-3 p-8">
    <Skeleton className="h-8 w-64" />
    <Skeleton className="h-40 w-full" />
  </div>
);

/** `/signup` and `/signup/verify` (organisation sign-up, docs/web-on-api/signup.md), for ApiApp's route list (kept here so ApiApp changes by one line). */
export const signupRoutes = [
  <Route key="signup" path="/signup" element={<Suspense fallback={fallback}><ApiSignup /></Suspense>} />,
  <Route key="signup-verify" path="/signup/verify" element={<Suspense fallback={fallback}><ApiSignupVerify /></Suspense>} />,
];
