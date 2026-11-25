import { lazy } from "react";
import { staffMayKeepVisitors, staffMayReadItems } from "@figbloom/shared";
import { Lazy } from "./Lazy";
import type { AreaPages } from "./types";

const StaffVisitors = lazy(() => import("../../screens/staff/Staff").then((m) => ({ default: m.StaffVisitors })));
const StaffNotices = lazy(() => import("../../screens/staff/Staff").then((m) => ({ default: m.StaffNotices })));
const StaffAccount = lazy(() => import("../../screens/staff/Staff").then((m) => ({ default: m.StaffAccount })));
const StaffItems = lazy(() => import("../../screens/teacher/Items").then((m) => ({ default: m.TeacherItems })));
const MyChats = lazy(() => import("../../screens/chat/MyChats").then((m) => ({ default: m.MyChats })));
const TeacherLeave = lazy(() => import("../../screens/teacher/Leave").then((m) => ({ default: m.TeacherLeave })));

/**
 * The staff console (role "staff"): the pages of other staff, by their address under /s/<slug>/. The home (`staff`) and the menu
 * are the shell's (ApiConsole.tsx). Not here, and so not in the menu: Loans (a preview with no backend anywhere). My HR is in
 * `my-hr.pages.tsx` (shown only while the API's status for the person is `available`). `staff/items` is for people holding the
 * Inventory area and `staff/visitors` for people holding the Visitors area (`when`).
 */
export const pages: AreaPages = {
  staff: [
    { path: "staff/visitors", when: staffMayKeepVisitors, element: <Lazy><StaffVisitors /></Lazy> },
    { path: "staff/notices", element: <Lazy><StaffNotices /></Lazy> },
    { path: "staff/chats", element: <Lazy><MyChats role="staff" /></Lazy> },
    { path: "staff/leave", element: <Lazy><TeacherLeave /></Lazy> },
    { path: "staff/account", element: <Lazy><StaffAccount /></Lazy> },
    { path: "staff/items", when: staffMayReadItems, element: <Lazy><StaffItems /></Lazy> },
  ],
};
