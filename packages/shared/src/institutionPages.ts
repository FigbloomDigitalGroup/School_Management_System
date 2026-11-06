import type { InstitutionType } from "./types";

/**
 * Which screens belong to which kind of institution (FIG-1437). One list, used twice: the sidebar leaves a screen out of the menu
 * (ConsoleShell, AreasHome) and the router sends anyone who types or bookmarks its address back to their home (App.tsx, InstitutionGate).
 * Hiding a menu item alone never blocked the address, and two hand-kept lists had drifted: some K-12 screens were gated and some were not.
 *
 * Pages are written the way the menu writes them: relative to /s/<school>/ ("admin/classes", "teacher/sections").
 * Gradebook, Fees, People, Leave and the rest are in neither list: both kinds of institution use them.
 */

/** K-12 only. Classes, streams, subjects, term exams and what hangs on them (class registers, report cards, exam papers, learning
 *  materials, performance): a higher-education school has no classes, it runs course sections. */
export const K12_ONLY_PAGES: readonly string[] = [
  "admin/classes", "admin/subjects", "admin/exams", "admin/papers", "admin/report-cards", "admin/performance", "admin/materials",
  "teacher/classes", "teacher/attendance", "teacher/timetable", "teacher/messages", "teacher/notices", "teacher/homework",
  "teacher/exams", "teacher/report-cards", "teacher/materials", "teacher/performance",
  "parent/materials", "student/materials", "student/exams",
];

/** Higher education only: the course catalogue and the sections a lecturer teaches. */
export const HIGHER_ED_ONLY_PAGES: readonly string[] = ["admin/courses", "teacher/sections"];

const matches = (list: readonly string[], page: string) => list.some((p) => page === p || page.startsWith(p + "/"));

/** True when this kind of institution does not have the screen, however the person got to its address. */
export function pageIsNotForInstitution(page: string, institutionType: InstitutionType): boolean {
  return matches(institutionType === "higher_ed" ? K12_ONLY_PAGES : HIGHER_ED_ONLY_PAGES, page);
}

/** "/s/alliance/admin/classes/" -> "admin/classes", for a path that belongs to this school; null for any other path. */
export function pageOfPath(pathname: string, slug: string): string | null {
  const prefix = `/s/${slug}/`;
  if (!pathname.startsWith(prefix)) return null;
  return pathname.slice(prefix.length).replace(/\/+$/, "");
}
