import { supabase } from "./supabase";
import { CBC_RUBRIC_4 } from "./gradingSchemes";

/**
 * Core competencies and values: what a CBC report card rates beside the
 * learning areas. The class teacher picks a level on the four-level rubric
 * (EE / ME / AE / BE) for each, once a term. Storage:
 * supabase/migrations/20261026010000_core_competencies.sql.
 *
 * The codes are stored, the labels are not, so wording can change here
 * without touching old ratings. Don't rename a code that has ratings.
 */

export type CompetencyKind = "competency" | "value";

export interface CompetencyItem { kind: CompetencyKind; code: string; label: string }

/** KICD's seven core competencies. */
export const CORE_COMPETENCIES: CompetencyItem[] = [
  { kind: "competency", code: "communication", label: "Communication and collaboration" },
  { kind: "competency", code: "critical_thinking", label: "Critical thinking and problem solving" },
  { kind: "competency", code: "creativity", label: "Creativity and imagination" },
  { kind: "competency", code: "citizenship", label: "Citizenship" },
  { kind: "competency", code: "digital_literacy", label: "Digital literacy" },
  { kind: "competency", code: "learning_to_learn", label: "Learning to learn" },
  { kind: "competency", code: "self_efficacy", label: "Self-efficacy" },
];

/** The national values CBC report cards rate. */
export const CORE_VALUES: CompetencyItem[] = [
  { kind: "value", code: "love", label: "Love" },
  { kind: "value", code: "responsibility", label: "Responsibility" },
  { kind: "value", code: "respect", label: "Respect" },
  { kind: "value", code: "unity", label: "Unity" },
  { kind: "value", code: "peace", label: "Peace" },
  { kind: "value", code: "patriotism", label: "Patriotism" },
  { kind: "value", code: "integrity", label: "Integrity" },
];

export const COMPETENCY_ITEMS: CompetencyItem[] = [...CORE_COMPETENCIES, ...CORE_VALUES];

/** EE / ME / AE / BE, best first. */
export const COMPETENCY_LEVELS = CBC_RUBRIC_4;

export const competencyKey = (kind: CompetencyKind, code: string) => `${kind}:${code}`;

/** A rating as it goes on a report card: in list order, with labels. Items not rated are left out. */
export interface RatedItem { kind: CompetencyKind; label: string; level: string; levelLabel: string }

export function ratedItems(levels: Map<string, string> | undefined): RatedItem[] {
  if (!levels) return [];
  return COMPETENCY_ITEMS.flatMap((it) => {
    const level = levels.get(competencyKey(it.kind, it.code));
    if (!level) return [];
    return [{ kind: it.kind, label: it.label, level, levelLabel: COMPETENCY_LEVELS.find((l) => l.code === level)?.label ?? level }];
  });
}

/** How many of a learner's items are rated, for "9 of 14 rated". */
export function ratedCount(levels: Map<string, string> | undefined): number {
  return COMPETENCY_ITEMS.filter((it) => levels?.has(competencyKey(it.kind, it.code))).length;
}

/** Every rating for these learners in a term: student id -> (kind:code -> level). */
export async function fetchCompetencyRatings(termId: string, studentIds: string[]): Promise<Map<string, Map<string, string>>> {
  const out = new Map<string, Map<string, string>>();
  if (!studentIds.length) return out;
  const { data, error } = await supabase().from("learner_competencies")
    .select("student_id, kind, item, level_code").eq("term_id", termId).in("student_id", studentIds)
    .returns<{ student_id: string; kind: CompetencyKind; item: string; level_code: string }[]>();
  if (error) throw new Error(error.message);
  for (const r of data ?? []) {
    const m = out.get(r.student_id) ?? new Map<string, string>();
    m.set(competencyKey(r.kind, r.item), r.level_code);
    out.set(r.student_id, m);
  }
  return out;
}

/** Sets one rating, or clears it with level null. Only the class teacher or the office may. */
export async function saveCompetencyRating(
  tenantId: string, termId: string, studentId: string, kind: CompetencyKind, item: string, level: string | null,
): Promise<void> {
  if (level === null) {
    const { error } = await supabase().from("learner_competencies").delete()
      .eq("term_id", termId).eq("student_id", studentId).eq("kind", kind).eq("item", item);
    if (error) throw new Error(error.message);
    return;
  }
  const { data, error } = await supabase().from("learner_competencies")
    .upsert({ tenant_id: tenantId, term_id: termId, student_id: studentId, kind, item, level_code: level }, { onConflict: "term_id,student_id,kind,item" })
    .select("id");
  if (error) throw new Error(error.message);
  if (!data?.length) throw new Error("Only the class teacher or the office can rate this learner.");
}
