import { lazy } from "react";
import { Lazy } from "./Lazy";
import type { AreaPages } from "./types";

const AdminVisitors = lazy(() => import("../../screens/admin/Visitors").then((m) => ({ default: m.AdminVisitors })));
const TeacherVisitors = lazy(() => import("../../screens/teacher/Visitors").then((m) => ({ default: m.TeacherVisitors })));

/** Gate & reception visitor log (admin/visitors, teacher/visitors). */
export const pages: AreaPages = {
  admin: [{ path: "admin/visitors", element: <Lazy><AdminVisitors /></Lazy> }],
  teacher: [{ path: "teacher/visitors", element: <Lazy><TeacherVisitors /></Lazy> }],
};
