import { lazy } from "react";
import { Lazy } from "./Lazy";
import type { AreaPages } from "./types";

const AdminAuditLog = lazy(() => import("../../screens/admin/AuditLog").then((m) => ({ default: m.AdminAuditLog })));

/**
 * The school's audit log (admin/audit): a full administrator, and whoever holds the Audit area (the page gate is
 * `ADMIN_PAGE_AREA["admin/audit"]`, the same on both builds). See docs/web-on-api/audit.md.
 */
export const pages: AreaPages = {
  admin: [{ path: "admin/audit", element: <Lazy><AdminAuditLog /></Lazy> }],
};
