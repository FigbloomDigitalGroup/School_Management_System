import { lazy } from "react";
import { Lazy } from "./Lazy";
import type { AreaPages } from "./types";

const ExamPapers = lazy(() => import("../../screens/teacher/ExamPapers").then((m) => ({ default: m.ExamPapers })));

/** Exam papers & tests (admin/papers, teacher/exams). */
export const pages: AreaPages = {
  admin: [{ path: "admin/papers", element: <Lazy><ExamPapers admin /></Lazy> }],
  teacher: [{ path: "teacher/exams", element: <Lazy><ExamPapers /></Lazy> }],
};
