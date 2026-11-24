import { lazy } from "react";
import { Lazy } from "./Lazy";
import type { AreaPages } from "./types";

const AdminVisitors = lazy(() => import("../../screens/admin/Visitors").then((m) => ({ default: m.AdminVisitors })));

/** Gate & reception visitor log (admin/visitors). */
export const pages: AreaPages = {
  admin: [{ path: "admin/visitors", element: <Lazy><AdminVisitors /></Lazy> }],
};
