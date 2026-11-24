import { lazy } from "react";
import { Lazy } from "./Lazy";
import type { AreaPages } from "./types";

// Buses (the live maps pull in the Google Maps script), loaded when opened.
const Fleet = lazy(() => import("../../screens/admin/Fleet").then((m) => ({ default: m.Fleet })));
const TeacherBuses = lazy(() => import("../../screens/teacher/Buses").then((m) => ({ default: m.TeacherBuses })));

/**
 * Buses and fleet (admin/fleet, teacher/buses). The driver's own pages are not here: a driver has no console, so ApiConsole hands a
 * driver to ApiDriver.tsx.
 */
export const pages: AreaPages = {
  admin: [{ path: "admin/fleet", element: <Lazy><Fleet /></Lazy> }],
  teacher: [{ path: "teacher/buses", element: <Lazy><TeacherBuses /></Lazy> }],
};
