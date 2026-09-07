/**
 * Local data so every screen renders before Supabase is wired up.
 *
 * Each export mirrors the shape of the query that will replace it — the call is
 * named in a comment above it. Swap one at a time; the components do not change.
 */
import {
  DEMO_CLASSES, DEMO_FEE_ITEMS, DEMO_SUBJECTS, DEMO_TENANTS, DEMO_TIMETABLE,
  FIRST_NAMES, LAST_NAMES, gradeFor,
  type Student, type Tenant,
} from "@figbloom/shared";

const id = (p: string, n: number) => `${p}-${String(n).padStart(4, "0")}`;

/** supabase.from("tenants").select("*") */
export const tenants: Tenant[] = DEMO_TENANTS.map((t, i) => ({
  ...t,
  id: id("ten", i + 1),
  created_at: new Date(2024, i % 12, 12).toISOString(),
}));

export const tenantBySlug = (slug?: string) => tenants.find((t) => t.slug === slug) ?? tenants[0]!;

export const classes = DEMO_CLASSES.map((c, i) => ({ ...c, id: id("cls", i + 1), tenant_id: tenants[0]!.id, class_teacher_id: null }));
export const subjects = DEMO_SUBJECTS.map((s, i) => ({ ...s, id: id("sub", i + 1), tenant_id: tenants[0]!.id }));

/** Deterministic roster — the same names every reload, so screenshots are stable. */
function roster(classId: string, count: number, seed: number): Student[] {
  return Array.from({ length: count }, (_, i) => {
    const fi = (seed * 7 + i * 3) % FIRST_NAMES.length;
    const li = (seed * 5 + i * 11) % LAST_NAMES.length;
    return {
      id: id(`stu-${classId}`, i + 1),
      tenant_id: tenants[0]!.id,
      admission_no: String(4000 + seed * 60 + i),
      full_name: `${FIRST_NAMES[fi]} ${LAST_NAMES[li]}`,
      class_id: classId,
      date_of_birth: null,
      boarding: i % 3 !== 0,
      active: true,
    };
  }).sort((a, b) => a.full_name.localeCompare(b.full_name));
}

export const studentsByClass: Record<string, Student[]> = Object.fromEntries(
  classes.map((c, i) => [c.id, roster(c.id, 38 + (i % 5), i + 1)])
);

export const allStudents = Object.values(studentsByClass).flat();

export const feeItems = DEMO_FEE_ITEMS.map((it, i) => ({ ...it, id: id("fee", i + 1), tenant_id: tenants[0]!.id, term_id: "term-3-2026" }));

export const timetable = DEMO_TIMETABLE;

/** Marks for one exam, keyed studentId -> subject -> score. */
export function marksFor(classId: string, examSeed: number) {
  const out: Record<string, Record<string, number | null>> = {};
  for (const [i, s] of (studentsByClass[classId] ?? []).entries()) {
    out[s.id] = {};
    for (const [j, sub] of subjects.entries()) {
      const base = 42 + ((i * 13 + j * 29 + examSeed * 7) % 52);
      out[s.id]![sub.name] = i % 17 === 0 && j % 4 === 0 ? null : base;
    }
  }
  return out;
}

export const classMean = (classId: string, subject: string, examSeed: number): number => {
  const m = marksFor(classId, examSeed);
  const vals = Object.values(m).map((r) => r[subject]).filter((v): v is number => v !== null);
  return Math.round(vals.reduce((a, b) => a + b, 0) / (vals.length || 1));
};

export const gradeOf = gradeFor;
