import { lazy } from "react";
import { Lazy } from "./Lazy";
import type { AreaPages } from "./types";

const AdminLeave = lazy(() => import("../../screens/admin/Leave").then((m) => ({ default: m.AdminLeave })));
const TeacherLeave = lazy(() => import("../../screens/teacher/Leave").then((m) => ({ default: m.TeacherLeave })));

/** Leave requests (W4). */
export const pages: AreaPages = {
  admin: [{ path: "admin/leave", element: <Lazy><AdminLeave /></Lazy> }],
  teacher: [{ path: "teacher/leave", element: <Lazy><TeacherLeave /></Lazy> }],
};
