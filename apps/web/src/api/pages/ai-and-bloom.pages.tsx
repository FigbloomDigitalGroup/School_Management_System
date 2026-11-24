import { lazy } from "react";
import { Lazy } from "./Lazy";
import type { AreaPages } from "./types";

const AdminAssistant = lazy(() => import("../../screens/admin/Assistant").then((m) => ({ default: m.AdminAssistant })));
const AdminStudyHelper = lazy(() => import("../../screens/admin/StudyHelper").then((m) => ({ default: m.AdminStudyHelper })));
const BloomChat = lazy(() => import("../../screens/bloom/BloomChat").then((m) => ({ default: m.BloomChat })));

/** The School assistant, the Bloom study helper and the Bloom chat (the Guide and Ask Bloom buttons are in `ApiConsole.tsx`). */
export const pages: AreaPages = {
  admin: [
    { path: "admin/assistant", element: <Lazy><AdminAssistant /></Lazy> },
    { path: "admin/study-helper", element: <Lazy><AdminStudyHelper /></Lazy> },
    { path: "admin/bloom", element: <Lazy><BloomChat console="admin" /></Lazy> },
  ],
  teacher: [{ path: "teacher/bloom", element: <Lazy><BloomChat console="teacher" /></Lazy> }],
};
