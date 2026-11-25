import { lazy } from "react";
import { Lazy } from "./Lazy";
import type { AreaPages } from "./types";

const LearningMaterials = lazy(() => import("../../screens/teacher/LearningMaterials").then((m) => ({ default: m.LearningMaterials })));

/** Learning materials (admin/materials, teacher/materials). */
export const pages: AreaPages = {
  admin: [{ path: "admin/materials", element: <Lazy><LearningMaterials admin /></Lazy> }],
  teacher: [{ path: "teacher/materials", element: <Lazy><LearningMaterials /></Lazy> }],
};
