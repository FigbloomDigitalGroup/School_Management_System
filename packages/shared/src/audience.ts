import { classAudienceIncludes, type Audience, type ClassLevel, type Role } from "./types";
import { targetYearLabel, yearMatches } from "./levels";

/**
 * Who an announcement is for, decided in one place. Every inbox (parent,
 * student and teacher, on web and both mobile apps) filters with
 * audienceIncludes(). The database enforces the same rule on its own:
 * audience_reaches() in
 * supabase/migrations/20261026030000_announcement_audiences.sql decides who
 * may read an announcement and, through announcement_recipients(), who
 * send-push notifies. If you change one, change the other.
 */

export type AudienceRecipients = "guardians" | "students" | "both";

/** The person reading. classIds/years are the classes a class- or
 *  year-wide notice reaches them through: a student's own class, or a
 *  parent's children's classes. Staff leave both empty -- class and year
 *  notices go to parents and students, not to the people teaching them. */
export interface AudienceViewer {
  profileId: string;
  role: Role;
  classIds: readonly string[];
  years: readonly { level: ClassLevel | null | undefined; year: number }[];
}

/** "All staff": everyone who works at the school, drivers included. */
export const STAFF_ROLES: Role[] = ["school_admin", "teacher", "driver"];

/** Which side of a class a role reads class notices from, if either. Taken
 *  from the role alone so a teacher who is also somebody's guardian still
 *  only gets a teacher's inbox -- the SQL rule does the same. */
export function audienceSide(role: Role): "guardians" | "students" | null {
  if (role === "parent") return "guardians";
  if (role === "student") return "students";
  return null;
}

export function audienceIncludes(audience: Audience | null | undefined, viewer: AudienceViewer): boolean {
  if (!audience) return false;
  switch (audience.kind) {
    case "whole_school": return true;
    case "role": return audience.role === viewer.role;
    case "roles": return (audience.roles ?? []).includes(viewer.role);
    case "user": return audience.user_id === viewer.profileId;
    case "people": return (audience.profile_ids ?? []).includes(viewer.profileId);
    case "class": {
      const side = audienceSide(viewer.role);
      return !!side && viewer.classIds.includes(audience.class_id) && classAudienceIncludes(audience.recipients, side);
    }
    case "form_level": {
      const side = audienceSide(viewer.role);
      return !!side && classAudienceIncludes(audience.recipients, side)
        && viewer.years.some((y) => yearMatches({ level: audience.level, year: audience.form_level }, { level: y.level, year: y.year }));
    }
    default: return false; // a kind this build doesn't know -- never guess
  }
}

const ROLE_GROUP_LABEL: Partial<Record<Role, string>> = {
  school_admin: "admins",
  teacher: "teachers",
  driver: "drivers",
  parent: "parents",
  student: "students",
};

function recipientsWord(r: AudienceRecipients | undefined): string {
  if (r === "guardians") return "Parents";
  if (r === "students") return "Students";
  return "Parents and students";
}

/** A short "who this went to" for a sent item, e.g. "All teachers",
 *  "Parents of Form 2 West", "3 people". Callers prefix "To: ". */
export function audienceLabel(
  audience: Audience | null | undefined,
  lookup: { className?: (id: string) => string | undefined; personName?: (id: string) => string | undefined } = {},
): string {
  if (!audience) return "Nobody";
  switch (audience.kind) {
    case "whole_school": return "Whole school";
    case "role": return `All ${ROLE_GROUP_LABEL[audience.role] ?? audience.role}`;
    case "roles": {
      const roles = audience.roles ?? [];
      if (STAFF_ROLES.every((r) => roles.includes(r)) && roles.length === STAFF_ROLES.length) return "All staff";
      const words = roles.map((r) => ROLE_GROUP_LABEL[r] ?? r);
      if (words.length <= 1) return `All ${words[0] ?? "staff"}`;
      return `All ${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
    }
    case "class": return `${recipientsWord(audience.recipients)} of ${lookup.className?.(audience.class_id) ?? "a class"}`;
    case "form_level": return `${recipientsWord(audience.recipients)} of ${targetYearLabel(audience.level, audience.form_level)}`;
    case "user": return lookup.personName?.(audience.user_id) ?? "1 person";
    case "people": {
      const ids = audience.profile_ids ?? [];
      if (ids.length === 1) return lookup.personName?.(ids[0]!) ?? "1 person";
      return `${ids.length} people`;
    }
    default: return "Unknown audience";
  }
}
