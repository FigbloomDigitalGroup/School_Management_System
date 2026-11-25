import { lazy, Suspense } from "react";
import { Route } from "react-router-dom";
import { HR_LAUNCH_PATH } from "@figbloom/shared";

// Figbloom HR's launch tab loads only when someone opens HR from the menu: it is the "Opening Figbloom HR" screen, and has no console.
const HrLaunch = lazy(() => import("../screens/hr/HrLaunch").then((m) => ({ default: m.HrLaunch })));

/**
 * The launch tab's address (`/hr/launch?school=<id>&slug=<slug>`), for ApiApp's route list (kept here so ApiApp changes by one line).
 * It is a route of the app, outside the school's console, so it sits inside the API session guard but not inside a school: it asks the
 * API for the one-time sign-in link for the school in its address, as the signed-in person. The fallback is empty (the screen that
 * follows is a full-page loader of its own).
 */
export const hrRoutes = [
  <Route key="hr-launch" path={HR_LAUNCH_PATH} element={<Suspense fallback={null}><HrLaunch /></Suspense>} />,
];
