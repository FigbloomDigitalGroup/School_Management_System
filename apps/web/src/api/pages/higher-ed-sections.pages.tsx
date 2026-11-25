import { lazy } from "react";
import { Lazy } from "./Lazy";
import type { AreaPages } from "./types";

const TeacherMySections = lazy(() => import("../../screens/teacher/MySections").then((m) => ({ default: m.TeacherMySections })));

/**
 * A lecturer's sections ("My sections", higher-education schools). The menu shows it only for a higher-education school: the
 * shared list in institutionPages.ts (HIGHER_ED_ONLY_PAGES) leaves it out of a K-12 school's menu, as on the Supabase build.
 */
export const pages: AreaPages = {
  teacher: [{ path: "teacher/sections", element: <Lazy><TeacherMySections /></Lazy> }],
};
