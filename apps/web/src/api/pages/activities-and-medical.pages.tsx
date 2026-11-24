import { lazy } from "react";
import { Lazy } from "./Lazy";
import type { AreaPages } from "./types";

const Activities = lazy(() => import("../../screens/admin/Activities").then((m) => ({ default: m.Activities })));
const AdminMedical = lazy(() => import("../../screens/admin/Medical").then((m) => ({ default: m.AdminMedical })));

/** Sports & activities (administrators, and teachers who hold the Activities area: one screen) and the Sick bay. */
export const pages: AreaPages = {
  admin: [
    { path: "admin/activities", element: <Lazy><Activities admin /></Lazy> },
    { path: "admin/medical", element: <Lazy><AdminMedical /></Lazy> },
  ],
  teacher: [{ path: "teacher/activities", element: <Lazy><Activities /></Lazy> }],
};
