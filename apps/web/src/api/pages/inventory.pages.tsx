import { lazy } from "react";
import { Lazy } from "./Lazy";
import type { AreaPages } from "./types";

const AdminInventory = lazy(() => import("../../screens/admin/Inventory").then((m) => ({ default: m.AdminInventory })));
const TeacherItems = lazy(() => import("../../screens/teacher/Items").then((m) => ({ default: m.TeacherItems })));

/** Inventory (W4: admin/inventory, teacher/items). */
export const pages: AreaPages = {
  admin: [{ path: "admin/inventory", element: <Lazy><AdminInventory /></Lazy> }],
  teacher: [{ path: "teacher/items", element: <Lazy><TeacherItems /></Lazy> }],
};
