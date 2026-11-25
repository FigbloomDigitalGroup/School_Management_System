import { lazy } from "react";
import { Lazy } from "./Lazy";
import type { AreaPages } from "./types";

const MyChats = lazy(() => import("../../screens/chat/MyChats").then((m) => ({ default: m.MyChats })));
const StudentExams = lazy(() => import("../../screens/student/Exams").then((m) => ({ default: m.StudentExams })));
const StudentFees = lazy(() => import("../../screens/student/Fees").then((m) => ({ default: m.StudentFees })));
const StudyHelper = lazy(() => import("../../screens/student/StudyHelper").then((m) => ({ default: m.StudyHelper })));

/**
 * The student pages where a learner acts: Fees (pay by M-Pesa), Exams & tests (sit an online paper), Chats (with their class teachers and the
 * school office) and Ask Bloom (the study helper). The pages that only read are in `student.pages.tsx`.
 */
export const pages: AreaPages = {
  student: [
    { path: "student/exams", element: <Lazy><StudentExams /></Lazy> },
    { path: "student/study-helper", element: <Lazy><StudyHelper /></Lazy> },
    { path: "student/chats", element: <Lazy><MyChats role="student" /></Lazy> },
    { path: "student/fees", element: <Lazy><StudentFees /></Lazy> },
  ],
};
