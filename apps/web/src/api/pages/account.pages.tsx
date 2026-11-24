import { lazy } from "react";
import { Lazy } from "./Lazy";
import type { AreaPages } from "./types";

const AccessRoles = lazy(() => import("../../screens/admin/AccessRoles").then((m) => ({ default: m.AccessRoles })));
const AdminAccount = lazy(() => import("../../screens/admin/Account").then((m) => ({ default: m.AdminAccount })));
const TeacherAccount = lazy(() => import("../../screens/teacher/Account").then((m) => ({ default: m.TeacherAccount })));

/** My account and Access & roles (W2). */
export const pages: AreaPages = {
  admin: [
    { path: "admin/access", element: <Lazy><AccessRoles /></Lazy> },
    { path: "admin/account", element: <Lazy><AdminAccount /></Lazy> },
  ],
  teacher: [
    // A teacher who holds admin areas uses admin/account in the admin console, so this page is not served there.
    { path: "teacher/account", inAdminConsole: false, element: <Lazy><TeacherAccount /></Lazy> },
  ],
};
