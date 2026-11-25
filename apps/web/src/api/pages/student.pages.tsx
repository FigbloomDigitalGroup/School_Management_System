import { lazy } from "react";
import { Lazy } from "./Lazy";
import type { AreaPages } from "./types";

const StudentActivities = lazy(() => import("../../screens/student/Activities").then((m) => ({ default: m.StudentActivities })));
const StudentItems = lazy(() => import("../../screens/student/Items").then((m) => ({ default: m.StudentItems })));
const StudentMaterials = lazy(() => import("../../screens/student/Materials").then((m) => ({ default: m.StudentMaterials })));
const StudentNotices = lazy(() => import("../../screens/student/Notices").then((m) => ({ default: m.StudentNotices })));
const StudentResults = lazy(() => import("../../screens/student/Results").then((m) => ({ default: m.StudentResults })));
const StudentTimetable = lazy(() => import("../../screens/student/Timetable").then((m) => ({ default: m.StudentTimetable })));
const StudentWork = lazy(() => import("../../screens/student/Work").then((m) => ({ default: m.StudentWork })));

/**
 * The student pages that only read (Timetable, Work, Learning materials, Results, Sports & activities, Notices, My items), served by
 * `ApiStudent.tsx`, which also holds Today (the home). The pages where a learner acts (Fees, Exams & tests, Chats, Ask Bloom) are in
 * `student-actions.pages.tsx`.
 */
export const pages: AreaPages = {
  student: [
    { path: "student/timetable", element: <Lazy><StudentTimetable /></Lazy> },
    { path: "student/work", element: <Lazy><StudentWork /></Lazy> },
    { path: "student/materials", element: <Lazy><StudentMaterials /></Lazy> },
    { path: "student/results", element: <Lazy><StudentResults /></Lazy> },
    { path: "student/activities", element: <Lazy><StudentActivities /></Lazy> },
    { path: "student/notices", element: <Lazy><StudentNotices /></Lazy> },
    { path: "student/items", element: <Lazy><StudentItems /></Lazy> },
  ],
};
