import { attendanceFigures, countAttendance, type PercentageMode, type SessionEntry, type SignOutDay } from "@figbloom/shared";

/** What the admin screens show for one class on one date, from both registers (FIG-1514). */
export interface ClassRegisterFigures {
  /** The morning / afternoon register has rows for this class and date. */
  amIn: boolean;
  pmIn: boolean;
  /** Counted in the school's percentage mode (here = present or late); early sign-outs left out of the afternoon. */
  here: number;
  total: number;
  /** Morning register detail, as the screens showed before the afternoon register existed. */
  late: number;
  absent: number;
}

/** Figures per class for the entries of one date. Classes with no entries are absent from the map. */
export function classRegisterFigures(entries: SessionEntry[], mode: PercentageMode, signOuts: SignOutDay[] = []): Map<string, ClassRegisterFigures> {
  const out = new Map<string, ClassRegisterFigures>();
  const get = (id: string): ClassRegisterFigures => {
    let f = out.get(id);
    if (!f) { f = { amIn: false, pmIn: false, here: 0, total: 0, late: 0, absent: 0 }; out.set(id, f); }
    return f;
  };
  for (const e of entries) {
    if (!e.class_id) continue;
    const f = get(e.class_id);
    if (e.session === "morning") {
      f.amIn = true;
      if (e.mark === "late") f.late += 1;
      if (e.mark === "absent") f.absent += 1;
    } else {
      f.pmIn = true;
    }
  }
  const byClass = new Map<string, ReturnType<typeof countAttendance>>();
  for (const u of countAttendance(entries, mode, signOuts)) {
    if (!u.class_id) continue;
    const list = byClass.get(u.class_id) ?? [];
    list.push(u);
    byClass.set(u.class_id, list);
  }
  for (const [id, units] of byClass) {
    const { here, total } = attendanceFigures(units);
    const f = get(id);
    f.here = here;
    f.total = total;
  }
  return out;
}

/** The latest of two optional dates ("YYYY-MM-DD" sorts as text). */
export function latestDate(a: string | null | undefined, b: string | null | undefined): string | null {
  if (a && b) return a > b ? a : b;
  return a ?? b ?? null;
}

/** "12 / 14": the counted figure. */
export function figureText(f: Pick<ClassRegisterFigures, "here" | "total">): string {
  return `${f.here} / ${f.total}`;
}
