import { lazy } from "react";
import { Lazy } from "./Lazy";
import type { AreaPages } from "./types";

const ExamPapers = lazy(() => import("../../screens/teacher/ExamPapers").then((m) => ({ default: m.ExamPapers })));

/** Exam papers & tests (admin/papers). */
export const pages: AreaPages = {
  admin: [{ path: "admin/papers", element: <Lazy><ExamPapers admin /></Lazy> }],
};
