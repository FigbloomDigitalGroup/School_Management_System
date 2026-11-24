import type { AdminPageDef, AreaPages, TeacherPageDef } from "./types";

/**
 * The pages of the API build. Each area registers its own in `<area>.pages.tsx` (a file in this folder that exports `pages`),
 * and this list picks every such file up, so a new area adds a file and edits nothing else: no two areas change the same
 * lines, and their pull requests do not conflict. See docs/WEB_ON_THE_NEW_API.md ("One file for each area").
 */
const files = import.meta.glob<{ pages?: AreaPages }>("./*.pages.tsx", { eager: true });

const areas = Object.keys(files)
  .sort()
  .map((file) => files[file]?.pages)
  .filter((pages): pages is AreaPages => pages !== undefined);

export const adminPageDefs: readonly AdminPageDef[] = areas.flatMap((a) => a.admin ?? []);
export const teacherPageDefs: readonly TeacherPageDef[] = areas.flatMap((a) => a.teacher ?? []);

/** The admin pages that run on the new API, by their menu address. Every other entry of the admin menu is hidden. */
export const API_ADMIN_PAGES: readonly string[] = ["admin", ...adminPageDefs.filter((p) => p.inMenu !== false).map((p) => p.menu ?? p.path)];

/** The teacher pages available on the API build. */
export const API_TEACHER_PAGES: readonly string[] = ["teacher", ...teacherPageDefs.filter((p) => p.inTeacherConsole !== false).map((p) => p.path)];
