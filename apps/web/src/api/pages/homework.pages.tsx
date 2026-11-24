import { lazy } from "react";
import { Lazy } from "./Lazy";
import type { AreaPages } from "./types";

const Homework = lazy(() => import("../../screens/teacher/Homework").then((m) => ({ default: m.Homework })));

/** Teacher homework (teacher/homework). */
export const pages: AreaPages = {
  teacher: [{ path: "teacher/homework", element: <Lazy><Homework /></Lazy> }],
};
