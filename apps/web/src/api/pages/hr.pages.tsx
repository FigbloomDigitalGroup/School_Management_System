import { lazy } from "react";
import { Lazy } from "./Lazy";
import type { AreaPages } from "./types";

const HrPayroll = lazy(() => import("../../screens/hr/HrPayroll").then((m) => ({ default: m.HrPayroll })));

/**
 * HR & Payroll (docs/web-on-api/hr-handoff.md): the connect page the sidebar's "HR & Payroll" item opens while HR is not yet there for
 * the school (it shows the school's state and "Request Figbloom HR"). It has no menu entry of its own: the item is a side action of the
 * console shell (lib/useHrItem.ts), which appears only for people who may be offered it and only while the API says the hand-off is on.
 * The address is gated like the Supabase build's (`ADMIN_PAGE_AREA["admin/hr"]` is the Fees area), and the page itself shows "isn't
 * available for your account" when the API's status is off or refuses the person.
 *
 * The launch tab (`/hr/launch`) is not a page of a school's console: it is a route of the app (`ApiHrRoutes.tsx`).
 */
export const pages: AreaPages = {
  admin: [{ path: "admin/hr", inMenu: false, element: <Lazy><HrPayroll /></Lazy> }],
};
