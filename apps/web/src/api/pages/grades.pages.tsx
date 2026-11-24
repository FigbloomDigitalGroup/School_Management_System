import { lazy } from "react";
import { Lazy } from "./Lazy";
import type { AreaPages } from "./types";

// The grades screens (the charts and the gradebooks are large) load when they are opened.
const AdminExams = lazy(() => import("../../screens/admin/Exams").then((m) => ({ default: m.Exams })));
const AdminReports = lazy(() => import("../../screens/admin/Reports").then((m) => ({ default: m.AdminReports })));
const Performance = lazy(() => import("../../screens/admin/Performance").then((m) => ({ default: m.Performance })));
const GradebookRouter = lazy(() => import("../../screens/teacher/GradebookRouter").then((m) => ({ default: m.GradebookRouter })));

/** Exams, the gradebook, performance and reports (W3). */
export const pages: AreaPages = {
  admin: [
    { path: "admin/exams", element: <Lazy><AdminExams /></Lazy> },
    { path: "admin/performance", element: <Lazy><Performance /></Lazy> },
    { path: "admin/reports", element: <Lazy><AdminReports /></Lazy> },
  ],
  teacher: [
    { path: "teacher/gradebook", element: <Lazy><GradebookRouter /></Lazy> },
    { path: "teacher/performance", element: <Lazy><Performance teacher /></Lazy> },
  ],
};
