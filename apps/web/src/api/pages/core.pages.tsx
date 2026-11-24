import { lazy } from "react";
import { Announcements } from "../../screens/admin/Announcements";
import { AdminClasses } from "../../screens/admin/Classes";
import { Fees } from "../../screens/admin/Fees";
import { AdminSubjects } from "../../screens/admin/Subjects";
import { BankReconciliation } from "../../screens/admin/BankReconciliation";
import { TermSetup } from "../../screens/admin/TermSetup";
import { Attendance as TeacherAttendance } from "../../screens/teacher/Attendance";
import { TeacherReports } from "../../screens/teacher/TeacherReports";
import { Lazy } from "./Lazy";
import type { AreaPages } from "./types";

// The People screen is large (its modals pull in a lot), so it loads when it is opened.
const People = lazy(() => import("../../screens/admin/People").then((m) => ({ default: m.People })));

/** School setup, People, Fees, Announcements and the teacher's Attendance: the first pages ported (W1 and W2). */
export const pages: AreaPages = {
  admin: [
    { path: "admin/people", element: <Lazy><People /></Lazy> },
    { path: "admin/fees", element: <Fees /> },
    { path: "admin/settings", element: <TermSetup /> },
    { path: "admin/classes", element: <AdminClasses /> },
    { path: "admin/subjects", element: <AdminSubjects /> },
    { path: "admin/announcements", element: <Announcements /> },
    // Bank reconciliation is opened from Fees: it has a route and no menu entry of its own.
    { path: "admin/bank-reconciliation", menu: "admin/fees", inMenu: false, element: <BankReconciliation /> },
  ],
  teacher: [
    { path: "teacher/attendance", element: <TeacherAttendance /> },
    // Reachable only from the admin console (a teacher who holds admin areas); not a page of the teacher console.
    { path: "teacher/reports", inTeacherConsole: false, element: <TeacherReports /> },
  ],
};
