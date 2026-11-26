import { lazy } from "react";
import { Lazy } from "./Lazy";
import type { AreaPages } from "./types";

const AdminBehaviour = lazy(() => import("../../screens/admin/Behaviour").then((m) => ({ default: m.AdminBehaviour })));
const TeacherBehaviour = lazy(() => import("../../screens/teacher/Behaviour").then((m) => ({ default: m.TeacherBehaviour })));
const ParentBehaviour = lazy(() => import("../../screens/parent/Behaviour").then((m) => ({ default: m.ParentBehaviour })));
const StudentBehaviour = lazy(() => import("../../screens/student/Behaviour").then((m) => ({ default: m.StudentBehaviour })));

/**
 * The behaviour and discipline log (docs/web-on-api/behaviour.md): the office's page (the Discipline area), the teacher's page, and the
 * pages where a parent and a learner read what the school shares. The screens are the Supabase app's own; the data behind them branches on
 * `onApi()` in `packages/shared/src/behaviour.ts`.
 */
export const pages: AreaPages = {
  admin: [{ path: "admin/behaviour", element: <Lazy><AdminBehaviour /></Lazy> }],
  // The office's page records for any learner, so a teacher who holds the Discipline area (who lands in the admin console) has no need of this one.
  teacher: [{ path: "teacher/behaviour", element: <Lazy><TeacherBehaviour /></Lazy>, inAdminConsole: false }],
  parent: [{ path: "parent/behaviour", element: <Lazy><ParentBehaviour /></Lazy> }],
  student: [{ path: "student/behaviour", element: <Lazy><StudentBehaviour /></Lazy> }],
};
