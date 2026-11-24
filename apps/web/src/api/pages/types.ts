import type { ReactNode } from "react";
import type { AdminArea } from "@figbloom/shared";

/** One admin-console page of the API build. */
export interface AdminPageDef {
  /** Its address under /s/<slug>/, e.g. "admin/people". */
  path: string;
  /** What the page shows. */
  element: ReactNode;
  /** The menu entry that gates it, when that is not `path` (a sub-page such as bank reconciliation belongs to "admin/fees"). */
  menu?: string;
  /** False for a page that has a route but no menu entry of its own. Default true. */
  inMenu?: boolean;
}

/**
 * One teacher page. It is served in the teacher console, and by address inside the admin console for a teacher who holds
 * admin areas (that person lands in the admin console, which has no console switch on the API build yet).
 */
export interface TeacherPageDef {
  /** Its address under /s/<slug>/, e.g. "teacher/leave". */
  path: string;
  /** What the page shows. */
  element: ReactNode;
  /** False when the page is not part of the teacher console (it is reachable only from the admin console). Default true. */
  inTeacherConsole?: boolean;
  /** False when the admin console has its own page for this (for example admin/account). Default true. */
  inAdminConsole?: boolean;
}

/**
 * One page of the staff console (role "staff": the librarian, the nurse, the receptionist). It is served in the staff console,
 * and by address inside the admin console for a staff member who holds admin areas. The staff home (`staff`) is not registered
 * here: it is the shell's own page, as `admin` and `teacher` are.
 */
export interface StaffPageDef {
  /** Its address under /s/<slug>/, e.g. "staff/leave". */
  path: string;
  /** What the page shows. */
  element: ReactNode;
  /** The page is in the menu only when this is true for the person's admin areas. Default: it is for every staff member. */
  when?: (areas: readonly AdminArea[]) => boolean;
}

/** What one area registers: the pages it ports onto the API build. */
export interface AreaPages {
  admin?: AdminPageDef[];
  teacher?: TeacherPageDef[];
  staff?: StaffPageDef[];
}
