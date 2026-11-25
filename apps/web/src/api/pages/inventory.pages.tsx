import { lazy } from "react";
import { Lazy } from "./Lazy";
import type { AreaPages } from "./types";

const AdminInventory = lazy(() => import("../../screens/admin/Inventory").then((m) => ({ default: m.AdminInventory })));
const InventoryStockPage = lazy(() => import("../../screens/admin/InventoryStockPages").then((m) => ({ default: m.InventoryStockPage })));
const TeacherItems = lazy(() => import("../../screens/teacher/Items").then((m) => ({ default: m.TeacherItems })));

/** Inventory (W4: admin/inventory, teacher/items) and its stock pages (S1c: admin/inventory/stock/:section). */
export const pages: AreaPages = {
  admin: [
    { path: "admin/inventory", element: <Lazy><AdminInventory /></Lazy> },
    // The Stock & kitchen widgets' own pages: opened from the Stock & kitchen tab, so no menu entry of their own (as bank reconciliation is from Fees).
    { path: "admin/inventory/stock/:section", menu: "admin/inventory", inMenu: false, element: <Lazy><InventoryStockPage /></Lazy> },
  ],
  teacher: [{ path: "teacher/items", element: <Lazy><TeacherItems /></Lazy> }],
};
