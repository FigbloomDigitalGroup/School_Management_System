import { lazy } from "react";
import { Lazy } from "./Lazy";
import { MyHrGate } from "./MyHrGate";
import type { AreaPages } from "./types";

const MyHr = lazy(() => import("../../screens/myhr/MyHr").then((m) => ({ default: m.MyHr })));

const mine = (home: "admin" | "teacher" | "staff") => <Lazy><MyHrGate home={home}><MyHr /></MyHrGate></Lazy>;

/**
 * My HR (docs/web-on-api/my-hr.md): one screen in the three consoles that share it. It reads the signed-in person's own payslips,
 * leave, attendance and KPIs through the API's HR proxy, which is off until the owner switches it on and links schools. So the
 * pages are registered here, but each shows only while the API's status for the person says "available": the menu entry is hidden
 * by ConsoleShell (lib/myHrNav.ts) and the address is closed by MyHrGate. Loans (`staff/loans`, `teacher/loans`) are not here: that
 * screen is a preview with no backend anywhere.
 */
export const pages: AreaPages = {
  admin: [{ path: "admin/my-hr", element: mine("admin") }],
  teacher: [{ path: "teacher/my-hr", element: mine("teacher") }],
  staff: [{ path: "staff/my-hr", element: mine("staff") }],
};
