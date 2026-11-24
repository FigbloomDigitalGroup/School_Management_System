import { lazy } from "react";
import { Lazy } from "./Lazy";
import type { AreaPages } from "./types";

const AdminCourses = lazy(() => import("../../screens/admin/Courses").then((m) => ({ default: m.AdminCourses })));
const TeacherTimetable = lazy(() => import("../../screens/teacher/Timetable").then((m) => ({ default: m.TeacherTimetable })));
const TeacherClasses = lazy(() => import("../../screens/teacher/Classes").then((m) => ({ default: m.TeacherClasses })));

/** Timetable, My classes and Courses (W2). */
export const pages: AreaPages = {
  admin: [{ path: "admin/courses", element: <Lazy><AdminCourses /></Lazy> }],
  teacher: [
    { path: "teacher/timetable", element: <Lazy><TeacherTimetable /></Lazy> },
    { path: "teacher/classes", element: <Lazy><TeacherClasses /></Lazy> },
  ],
};
