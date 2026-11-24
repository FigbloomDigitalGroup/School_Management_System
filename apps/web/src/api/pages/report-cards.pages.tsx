import { lazy } from "react";
import { Lazy } from "./Lazy";
import type { AreaPages } from "./types";

const ReportCards = lazy(() => import("../../screens/admin/ReportCards").then((m) => ({ default: m.ReportCards })));

/** Report cards and competency ratings (W3). */
export const pages: AreaPages = {
  admin: [{ path: "admin/report-cards", element: <Lazy><ReportCards /></Lazy> }],
  teacher: [{ path: "teacher/report-cards", element: <Lazy><ReportCards teacher /></Lazy> }],
};
