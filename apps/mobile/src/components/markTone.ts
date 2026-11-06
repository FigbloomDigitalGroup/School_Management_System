import type { AttendanceMark } from "@figbloom/shared";
import { perScheme } from "../theme";

/** The register's mark colours: shared MARK_STYLE's own values in light (they are these status tokens), dark washes in dark. */
export const MARK_TONE = perScheme((t): Record<AttendanceMark, { bg: string; ink: string }> => ({
  present: { bg: t.status.okBg, ink: t.status.okInk },
  absent: { bg: t.status.warnBg, ink: t.status.warnInk },
  late: { bg: t.brand.orangeSoft, ink: t.brand.orangeInk },
  excused: { bg: t.status.mutedBg, ink: t.status.mutedInk },
}));
