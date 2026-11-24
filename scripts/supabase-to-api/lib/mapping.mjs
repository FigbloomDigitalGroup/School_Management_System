// Pure mapping from a Supabase snapshot to apps/api request bodies. No network, no files: every rule the API
// enforces on these records is pre-checked here, so a row that would be refused is reported as BLOCKED, with the
// reason, before a single request is sent.
//
// Nothing here guesses at a missing required value. A child's gender in particular is never invented: a learner
// with none is blocked until the school supplies it (an `overrides` entry) or fixes it in Supabase.

// Same strings the API publishes (apps/api/src/modules/directory/contact.ts).
const PHONE = /^[0-9+()-][0-9+()\-\s]{3,30}[0-9+()-]$/;
const EMAIL = /^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$/;
const FORMULA_PREFIX = /^[=+\-@\t\r]/;
const SLUG = /^[a-z0-9][a-z0-9-]{2,35}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const FORM_BANDS = {
  pre_primary: [1, 2],
  primary: [1, 6],
  junior_secondary: [7, 9],
  senior_school: [10, 12],
  secondary: [1, 4],
};

/** Supabase role -> API staff classification. Roles missing here are not staff (parents, students, admins above a school). */
const STAFF_CLASSIFICATION = {
  school_admin: "school_admin",
  teacher: "teacher",
  driver: "driver",
  staff: "staff",
  guard: "staff",
  receptionist: "staff",
};
const STAFF_TITLE_FALLBACK = { guard: "Guard", receptionist: "Receptionist" };

const codePoints = (s) => [...s].length;
const trimmed = (v) => (typeof v === "string" ? v.trim() : v);
const blank = (v) => v === null || v === undefined || (typeof v === "string" && v.trim() === "");

function normaliseGender(raw) {
  if (blank(raw)) return null;
  const g = String(raw).trim().toLowerCase();
  if (g === "male" || g === "m" || g === "boy") return "male";
  if (g === "female" || g === "f" || g === "girl") return "female";
  return null;
}

/** Local calendar "today" in the school's own time zone, as YYYY-MM-DD. */
function todayIn(timeZone, now) {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/**
 * @param {object} snapshot  the files extract.mjs wrote, parsed: { organizations, tenants, terms, classes, profiles, students, guardians }
 * @param {object} [options]
 * @param {object} [options.overrides]  { schools: {slug: {admin_email}}, learners: {admission_no: {gender, date_of_birth}} }
 * @param {string[]} [options.only]     school slugs to plan; default all
 * @param {Date} [options.now]
 */
export function buildPlan(snapshot, options = {}) {
  const overrides = options.overrides ?? {};
  const now = options.now ?? new Date();
  const only = options.only?.length ? new Set(options.only) : null;
  const by = (rows, k) => {
    const m = new Map();
    for (const r of rows ?? []) {
      const key = r[k];
      if (!m.has(key)) m.set(key, []);
      m.get(key).push(r);
    }
    return m;
  };
  const orgById = new Map((snapshot.organizations ?? []).map((o) => [o.id, o]));
  const termsBy = by(snapshot.terms, "tenant_id");
  const classesBy = by(snapshot.classes, "tenant_id");
  const profilesBy = by(snapshot.profiles, "tenant_id");
  const studentsBy = by(snapshot.students, "tenant_id");
  const guardiansBy = by(snapshot.guardians, "tenant_id");

  const schools = [];
  for (const tenant of snapshot.tenants ?? []) {
    if (only && !only.has(tenant.slug)) continue;
    schools.push(
      planSchool({
        tenant,
        org: orgById.get(tenant.organization_id) ?? null,
        terms: termsBy.get(tenant.id) ?? [],
        classes: classesBy.get(tenant.id) ?? [],
        profiles: profilesBy.get(tenant.id) ?? [],
        students: studentsBy.get(tenant.id) ?? [],
        guardians: guardiansBy.get(tenant.id) ?? [],
        overrides,
        now,
      }),
    );
  }
  return { schools };
}

function planSchool({ tenant, org, terms, classes, profiles, students, guardians, overrides, now }) {
  const blocked = [];
  const warnings = [];
  const block = (kind, sourceId, reason) => blocked.push({ kind, sourceId, reason });
  const warn = (kind, sourceId, message) => warnings.push({ kind, sourceId, message });
  const sOver = overrides.schools?.[tenant.slug] ?? {};

  // ---- the school itself ----
  const school = { sourceId: tenant.id, slug: tenant.slug, name: tenant.name, status: tenant.status };
  const adminProfile = profiles.find((p) => p.role === "school_admin" && !p.archived_at && p.email && EMAIL.test(p.email.trim()));
  const adminEmail = sOver.admin_email ?? (adminProfile ? adminProfile.email.trim() : null);
  const provision = {
    school_name: trimmed(tenant.name),
    slug: tenant.slug,
    admin_email: adminEmail,
    admin_name: adminProfile ? trimmed(adminProfile.full_name).slice(0, 160) : undefined,
    organization: org ? { sourceId: org.id, name: trimmed(org.name) } : null,
  };
  if (!SLUG.test(tenant.slug)) block("school", tenant.id, "slug does not fit the API's pattern (3-36 of a-z, 0-9, hyphen)");
  if (codePoints(provision.school_name ?? "") < 2 || codePoints(provision.school_name) > 160) block("school", tenant.id, "school name must be 2-160 characters");
  if (!adminEmail) block("school", tenant.id, "no active school administrator with a valid email; give one in overrides.schools.<slug>.admin_email");
  if (!org) block("school", tenant.id, "school has no organization row in the snapshot");

  const timezone = tenant.timezone && tenant.timezone !== "Africa/Nairobi" ? tenant.timezone : undefined;
  const profilePatch = {};
  if (!blank(tenant.county)) profilePatch.county = tenant.county.trim();
  if (!blank(tenant.country)) profilePatch.country = tenant.country.trim();
  if (!blank(tenant.level)) profilePatch.level = String(tenant.level);
  if (tenant.institution_type === "k12" || tenant.institution_type === "higher_ed") profilePatch.institution_type = tenant.institution_type;
  if (!blank(tenant.moe_registration)) profilePatch.moe_registration = tenant.moe_registration.trim();
  if (!blank(tenant.accent) && /^(#[A-Za-z0-9_-]{1,31}|[A-Za-z0-9_-]{1,32})$/.test(tenant.accent.trim())) profilePatch.accent = tenant.accent.trim();
  else if (!blank(tenant.accent)) warn("school", tenant.id, "accent colour is not in the shape the API accepts; left out");
  if (timezone) profilePatch.timezone = timezone;

  // ---- academic years and terms ----
  const years = [];
  const termItems = [];
  const sortedTerms = [...terms].sort((a, b) => a.year - b.year || a.index - b.index);
  const yearGroups = new Map();
  for (const t of sortedTerms) {
    if (!ISO_DATE.test(String(t.starts_on)) || !ISO_DATE.test(String(t.ends_on)) || t.ends_on < t.starts_on) {
      block("term", t.id, "term dates are missing or end before they start");
      continue;
    }
    if (!Number.isInteger(t.index) || t.index < 1 || t.index > 4) {
      block("term", t.id, `term index ${t.index} is outside 1-4, which is all the API holds per year`);
      continue;
    }
    if (blank(t.name) || codePoints(t.name.trim()) > 64) {
      block("term", t.id, "term name must be 1-64 characters");
      continue;
    }
    if (!yearGroups.has(t.year)) yearGroups.set(t.year, []);
    const g = yearGroups.get(t.year);
    if (g.some((x) => x.index === t.index)) {
      block("term", t.id, `two terms share index ${t.index} in ${t.year}`);
      continue;
    }
    g.push(t);
  }
  const currentTerm = sortedTerms.find((t) => t.is_current && yearGroups.get(t.year)?.includes(t));
  const currentYear = currentTerm ? currentTerm.year : [...yearGroups.keys()].sort((a, b) => b - a)[0];
  for (const [year, group] of yearGroups) {
    const key = `year:${tenant.id}:${year}`;
    years.push({
      key,
      isCurrent: year === currentYear,
      body: {
        label: String(year),
        starts_on: group.map((t) => t.starts_on).sort()[0],
        ends_on: group.map((t) => t.ends_on).sort().at(-1),
        ...(year === currentYear ? { is_current: true } : {}),
      },
    });
    for (const t of group) {
      termItems.push({
        key: `term:${t.id}`,
        yearKey: key,
        isCurrent: currentTerm?.id === t.id,
        body: {
          index: t.index,
          label: t.name.trim(),
          starts_on: t.starts_on,
          ends_on: t.ends_on,
          ...(currentTerm?.id === t.id ? { is_current: true } : {}),
        },
      });
    }
  }
  if (years.length === 0) warn("school", tenant.id, "no usable terms, so there is no academic year to hold classes or class placements");
  const currentYearKey = years.find((y) => y.isCurrent)?.key ?? null;

  // ---- staff: everyone at the school who is not a parent or a student ----
  const staff = [];
  const staffKeyByProfile = new Map();
  for (const p of profiles) {
    const classification = STAFF_CLASSIFICATION[p.role];
    if (!classification) continue;
    const name = trimmed(p.full_name ?? "");
    if (blank(name) || codePoints(name) > 120) {
      block("staff", p.id, "name must be 1-120 characters");
      continue;
    }
    if (FORMULA_PREFIX.test(name)) {
      // The API's spreadsheet-injection guard applies to learners; staff names are not guarded, so only note it.
      warn("staff", p.id, "name starts with a character spreadsheets treat as a formula");
    }
    const body = { full_name: name, classification };
    const title = !blank(p.staff_title) ? p.staff_title.trim() : (STAFF_TITLE_FALLBACK[p.role] ?? null);
    if (title) body.staff_title = codePoints(title) > 120 ? [...title].slice(0, 120).join("") : title;
    if (!blank(p.phone)) {
      if (PHONE.test(p.phone.trim())) body.phone = p.phone.trim();
      else warn("staff", p.id, "phone is not in a shape the API accepts; left out");
    }
    if (!blank(p.email)) {
      if (EMAIL.test(p.email.trim()) && p.email.trim().length <= 254) body.email = p.email.trim();
      else warn("staff", p.id, "email is not in a shape the API accepts; left out");
    }
    const key = `staff:${p.id}`;
    staffKeyByProfile.set(p.id, key);
    staff.push({ key, archive: Boolean(p.archived_at), body });
  }

  // ---- classes (all in the current year: Supabase classes are not tied to a year) ----
  const classItems = [];
  const classKeyBySourceId = new Map();
  const seenClassNames = new Set();
  for (const c of classes) {
    if (!currentYearKey) {
      block("class", c.id, "no academic year to put it in");
      continue;
    }
    const name = trimmed(c.name ?? "");
    if (blank(name) || codePoints(name) > 64) {
      block("class", c.id, "class name must be 1-64 characters");
      continue;
    }
    if (seenClassNames.has(name.toLowerCase())) {
      block("class", c.id, "another class in this school has the same name (the API needs names unique per year)");
      continue;
    }
    const body = { name };
    if (Number.isInteger(c.form_level) && c.form_level >= 1 && c.form_level <= 12) body.form_level = c.form_level;
    else warn("class", c.id, "form level is outside 1-12; left out");
    const level = c.level;
    const band = FORM_BANDS[level];
    if (band) {
      if (body.form_level === undefined || (body.form_level >= band[0] && body.form_level <= band[1])) body.education_level = level;
      else warn("class", c.id, `form level ${body.form_level} is outside the ${level} band; education level left out`);
    }
    if (c.pathway) {
      if (body.education_level === "senior_school") body.pathway = c.pathway;
      else warn("class", c.id, "pathway only applies to senior school; left out");
    }
    if (!blank(c.stream)) {
      if (codePoints(c.stream.trim()) <= 32) body.stream = c.stream.trim();
      else warn("class", c.id, "stream is longer than 32 characters; left out");
    }
    seenClassNames.add(name.toLowerCase());
    const key = `class:${c.id}`;
    classKeyBySourceId.set(c.id, key);
    let teacherStaffKey = null;
    if (c.class_teacher_id) {
      teacherStaffKey = staffKeyByProfile.get(c.class_teacher_id) ?? null;
      if (!teacherStaffKey) warn("class", c.id, "class teacher is not among the staff being copied; left unset");
    }
    classItems.push({ key, yearKey: currentYearKey, teacherStaffKey, body });
  }

  // ---- learners ----
  const today = todayIn(tenant.timezone || "Africa/Nairobi", now);
  const learners = [];
  const learnerKeyBySourceId = new Map();
  const seenAdmission = new Set();
  for (const s of students) {
    const over = overrides.learners?.[trimmed(s.admission_no ?? "")] ?? {};
    const admission = trimmed(s.admission_no ?? "");
    const name = trimmed(s.full_name ?? "");
    if (blank(admission) || codePoints(admission) > 32) {
      block("learner", s.id, "admission number must be 1-32 characters");
      continue;
    }
    if (FORMULA_PREFIX.test(admission) || FORMULA_PREFIX.test(s.admission_no)) {
      block("learner", s.id, "admission number starts with = + - @ (the API refuses it as a spreadsheet-formula risk)");
      continue;
    }
    if (blank(name) || codePoints(name) > 120) {
      block("learner", s.id, "name must be 1-120 characters");
      continue;
    }
    if (FORMULA_PREFIX.test(name) || FORMULA_PREFIX.test(s.full_name)) {
      block("learner", s.id, "name starts with = + - @ (the API refuses it as a spreadsheet-formula risk)");
      continue;
    }
    if (seenAdmission.has(admission.toLowerCase())) {
      block("learner", s.id, "another learner has the same admission number (case aside)");
      continue;
    }
    const gender = normaliseGender(over.gender) ?? normaliseGender(s.gender);
    if (!gender) {
      block("learner", s.id, "gender is missing or not male/female, which the API requires; supply it in overrides.learners.<admission_no>.gender");
      continue;
    }
    seenAdmission.add(admission.toLowerCase());
    const body = { admission_no: admission, full_name: name, gender, boarding: Boolean(s.boarding) };
    const dob = over.date_of_birth ?? s.date_of_birth;
    if (!blank(dob)) {
      if (!ISO_DATE.test(String(dob))) warn("learner", s.id, "date of birth is not a calendar date; left out");
      else if (String(dob) > today) warn("learner", s.id, "date of birth is in the future; left out");
      else body.date_of_birth = String(dob);
    }
    const key = `learner:${s.id}`;
    learnerKeyBySourceId.set(s.id, key);
    let classKey = null;
    if (s.class_id) {
      classKey = classKeyBySourceId.get(s.class_id) ?? null;
      if (!classKey) warn("learner", s.id, "class is not among the classes being copied; no class placement");
    }
    learners.push({ key, classKey, archive: !s.active || Boolean(s.archived_at), body });
  }

  // ---- guardians: one API guardian per Supabase parent profile, linked to each of their learners ----
  const profileById = new Map(profiles.map((p) => [p.id, p]));
  const linksByProfile = new Map();
  for (const g of guardians) {
    if (!linksByProfile.has(g.profile_id)) linksByProfile.set(g.profile_id, []);
    linksByProfile.get(g.profile_id).push(g);
  }
  const guardianItems = [];
  for (const [profileId, rows] of linksByProfile) {
    const p = profileById.get(profileId);
    if (!p) {
      block("guardian", profileId, "the guardian's profile is not in the snapshot");
      continue;
    }
    const name = trimmed(p.full_name ?? "");
    if (blank(name) || codePoints(name) > 120) {
      block("guardian", profileId, "name must be 1-120 characters");
      continue;
    }
    const body = { full_name: name };
    for (const [field, value] of [["phone", p.phone], ["alt_phone", p.alt_phone]]) {
      if (blank(value)) continue;
      if (PHONE.test(value.trim())) body[field] = value.trim();
      else warn("guardian", profileId, `${field} is not in a shape the API accepts; left out`);
    }
    if (!blank(p.email)) {
      if (EMAIL.test(p.email.trim()) && p.email.trim().length <= 254) body.email = p.email.trim();
      else warn("guardian", profileId, "email is not in a shape the API accepts; left out");
    }
    const links = [];
    for (const r of rows) {
      const learnerKey = learnerKeyBySourceId.get(r.student_id);
      if (!learnerKey) {
        warn("guardian", profileId, "linked to a learner that is not being copied; that link is skipped");
        continue;
      }
      if (!["mother", "father", "guardian"].includes(r.relationship)) {
        warn("guardian", profileId, "relationship is not mother, father or guardian; that link is skipped");
        continue;
      }
      links.push({ key: `link:${profileId}:${r.student_id}`, learnerKey, relationship: r.relationship, is_primary_payer: Boolean(r.is_primary_payer) });
    }
    if (links.length === 0) {
      block("guardian", profileId, "none of their learners are being copied");
      continue;
    }
    guardianItems.push({ key: `guardian:${profileId}`, body, links });
  }

  // ---- what has nowhere to go in the API ----
  const count = (rows, pred) => rows.filter(pred).length;
  const notCarried = {
    learner_address_or_location: count(students, (s) => s.home_address || s.home_lat != null || s.home_landmark),
    learner_identity_numbers: count(students, (s) => s.birth_cert_no || s.upi_no),
    learner_nationality_religion_previous_school: count(students, (s) => s.nationality || s.religion || s.previous_school),
    learner_photo: count(students, (s) => s.avatar_url),
    staff_alt_phone_or_left_on: count(profiles, (p) => STAFF_CLASSIFICATION[p.role] && (p.alt_phone || p.left_on)),
    people_with_logins: count(profiles, (p) => p.login_id),
    school_settings: 1,
  };

  return {
    school,
    provision,
    profilePatch,
    years,
    terms: termItems,
    staff,
    classes: classItems,
    learners,
    guardians: guardianItems,
    blocked,
    warnings,
    notCarried,
  };
}

/** Counts only, no names: safe to print and to attach to a ticket. */
export function summarisePlan(plan) {
  return plan.schools.map((s) => {
    const blockedBy = {};
    for (const b of s.blocked) blockedBy[b.kind] = (blockedBy[b.kind] ?? 0) + 1;
    const warnedBy = {};
    for (const w of s.warnings) warnedBy[w.kind] = (warnedBy[w.kind] ?? 0) + 1;
    const reasons = {};
    for (const b of s.blocked) reasons[`${b.kind}: ${b.reason}`] = (reasons[`${b.kind}: ${b.reason}`] ?? 0) + 1;
    return {
      slug: s.school.slug,
      toCreate: {
        school: s.blocked.some((b) => b.kind === "school") ? 0 : 1,
        academic_years: s.years.length,
        terms: s.terms.length,
        staff: s.staff.length,
        classes: s.classes.length,
        learners: s.learners.length,
        class_placements: s.learners.filter((l) => l.classKey).length,
        guardians: s.guardians.length,
        guardian_links: s.guardians.reduce((n, g) => n + g.links.length, 0),
        to_archive_at_end: s.learners.filter((l) => l.archive).length + s.staff.filter((x) => x.archive).length,
      },
      blocked: blockedBy,
      blockedReasons: reasons,
      warnings: warnedBy,
      notCarried: s.notCarried,
    };
  });
}
