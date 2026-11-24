import { lazy } from "react";
import { Lazy } from "./Lazy";
import type { AreaPages } from "./types";

const AdminInventory = lazy(() => import("../../screens/admin/Inventory").then((m) => ({ default: m.AdminInventory })));

/** Inventory (W4). */
export const pages: AreaPages = {
  admin: [{ path: "admin/inventory", element: <Lazy><AdminInventory /></Lazy> }],
};
