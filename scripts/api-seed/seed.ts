/**
 * HTTP-only demo school seed for apps/api (FIG-1890).
 *
 * Runs AFTER `apps/api/scripts/bootstrap-admin.mjs` and against a running `apps/api` server:
 *   API_URL=http://127.0.0.1:4199 \
 *   BOOTSTRAP_ADMIN_EMAIL=bootstrap@figbloom.test \
 *   BOOTSTRAP_SETUP_TOKEN=<token from bootstrap-admin.mjs> \
 *   tsx scripts/api-seed/seed.ts
 *
 * Safe to re-run: reads existing records before creating, reads saved TOTP secrets from
 * `API_SEED_OUTPUT` (default `test-results/api-seed.json`), and enrols TOTP using stepOffset=-1
 * so immediate Playwright runs at stepOffset=0 never hit replay protection.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import {
  createApiClient,
  createMemoryTokenStore,
  isApiError,
  listAllPages,
  parseMfaEnrolment,
  parseMfaStatus,
  type ApiClient,
} from "../../packages/shared/src/api/index";
import { computeTotpCode } from "./totp";

export interface SeedOutput {
  apiUrl: string;
  tenantId: string;
  slug: string;
  schoolName: string;
  superAdmin: {
    email: string;
    password: string;
    totpSecret: string | null;
  };
  admin: {
    email: string;
    password: string;
    totpSecret: string;
    recoveryCodes: string[];
  };
  teacher: {
    email: string;
    password: string;
  };
  seeded: {
    academicYear: string;
    term: string;
    classes: string[];
    subjects: string[];
    learners: string[];
    feeItems: string[];
    announcements: string[];
  };
}

const API_URL = (process.env.API_URL ?? process.env.VITE_API_URL ?? "http://127.0.0.1:4199").replace(/\/+$/, "");
const OUTPUT_PATH = process.env.API_SEED_OUTPUT
  ? resolve(process.cwd(), process.env.API_SEED_OUTPUT)
  : resolve(tmpdir(), "figbloom-api-seed.json");

const SUPER_EMAIL = (process.env.BOOTSTRAP_ADMIN_EMAIL ?? "bootstrap@figbloom.test").trim().toLowerCase();
const SUPER_PASSWORD = process.env.API_SEED_SUPER_PASSWORD ?? "FigbloomSuper!2026";
const SETUP_TOKEN = (process.env.BOOTSTRAP_SETUP_TOKEN ?? "").trim();

const SCHOOL_NAME = "Alliance High School";
const SCHOOL_SLUG = "alliance";
const ADMIN_EMAIL = "principal@alliance.sc.ke";
const ADMIN_NAME = "Grace Wanjiku";
const ADMIN_PASSWORD = process.env.API_SEED_ADMIN_PASSWORD ?? "AllianceAdmin!2026";
const TEACHER_EMAIL = "teacher@alliance.sc.ke";
const TEACHER_NAME = "David Kamau";
const TEACHER_PASSWORD = process.env.API_SEED_TEACHER_PASSWORD ?? "AllianceTeacher!2026";

function readExistingOutput(): Partial<SeedOutput> | null {
  if (!existsSync(OUTPUT_PATH)) return null;
  try {
    return JSON.parse(readFileSync(OUTPUT_PATH, "utf8")) as Partial<SeedOutput>;
  } catch {
    return null;
  }
}

function makeClient(): ApiClient {
  return createApiClient({ baseUrl: API_URL, store: createMemoryTokenStore() });
}

async function loginAndSatisfyMfa(
  client: ApiClient,
  email: string,
  password: string,
  existingSecret: string | null | undefined,
): Promise<{ totpSecret: string | null; recoveryCodes: string[] }> {
  const login = await client.post("/v1/auth/login/email", {
    body: { email, password },
    auth: false,
    tenantId: null,
  });
  client.store.set({ token: login.token, expiresAt: login.expiresAt, userId: login.user.id });

  const status = parseMfaStatus(await client.get("/v1/auth/mfa/status", { tenantId: null }));
  if (status.next === "none") {
    return { totpSecret: existingSecret ?? null, recoveryCodes: [] };
  }

  if (status.next === "enroll") {
    let enrolmentRaw: unknown;
    try {
      enrolmentRaw = await client.post("/v1/auth/mfa/totp/enroll", { tenantId: null });
    } catch (err) {
      if (isApiError(err) && err.code === "reauth_required") {
        await client.post("/v1/auth/reauth", { body: { password }, tenantId: null, keepSessionOn401: true });
        enrolmentRaw = await client.post("/v1/auth/mfa/totp/enroll", { tenantId: null });
      } else {
        throw err;
      }
    }
    const enrolment = parseMfaEnrolment(enrolmentRaw);
    // Use stepOffset = -1 so immediate E2E login at stepOffset = 0 never collides with single-use step tracking.
    const code = computeTotpCode(enrolment.secret, Date.now(), -1);
    await client.post("/v1/auth/mfa/totp/verify", {
      body: { code },
      tenantId: null,
      keepSessionOn401: true,
    });
    return { totpSecret: enrolment.secret, recoveryCodes: enrolment.recoveryCodes };
  }

  // status.next === "challenge"
  if (!existingSecret) {
    throw new Error(`MFA challenge required for ${email}, but no existing TOTP secret was found in ${OUTPUT_PATH}.`);
  }
  await answerTotpChallenge(client, existingSecret);
  return { totpSecret: existingSecret, recoveryCodes: [] };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The re-run's MFA challenge. The API accepts a code only for a step LATER than the last one it accepted, and every
 * attempt, right or wrong, spends one of the account's 5 MFA attempts (refilled one a minute). An E2E sign-in moments
 * ago may already have used the current step, so trying steps blindly (-1, 0, +1) can spend the whole budget: CI's
 * idempotency re-run did, after leave.spec added a second admin sign-in. So: present the current step once; if it
 * is refused, wait for the next step and present that. Never +1: a sign-in at offset 0 right after this run would
 * then be refused for two steps. A spent budget (429) is waited out once.
 */
async function answerTotpChallenge(client: ApiClient, secret: string): Promise<void> {
  let waitedForNextStep = false;
  let waitedForBudget = false;
  for (;;) {
    try {
      await client.post("/v1/auth/mfa/challenge", {
        body: { code: computeTotpCode(secret, Date.now(), 0) },
        tenantId: null,
        keepSessionOn401: true,
      });
      return;
    } catch (err) {
      if (isApiError(err) && err.code === "unauthorized" && !waitedForNextStep) {
        waitedForNextStep = true;
        await sleep(30_000 - (Date.now() % 30_000) + 750);
        continue;
      }
      if (isApiError(err) && err.code === "rate_limited" && !waitedForBudget) {
        waitedForBudget = true;
        await sleep((err.retryAfterSeconds ?? 60) * 1000 + 500);
        continue;
      }
      throw err;
    }
  }
}

async function main() {
  const prev = readExistingOutput();

  // 1. Wait for API readiness (handles startup race when run immediately after starting the API).
  let ready = false;
  for (let i = 0; i < 30 && !ready; i++) {
    try {
      const res = await fetch(`${API_URL}/readyz`);
      ready = res.status === 200;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (!ready) throw new Error(`API at ${API_URL} did not become ready.`);

  // 2. Complete super-admin bootstrap password if a setup token was provided.
  const superClient = makeClient();
  if (SETUP_TOKEN) {
    try {
      await superClient.post("/v1/auth/password-reset/complete", {
        body: { token: SETUP_TOKEN, password: SUPER_PASSWORD },
        auth: false,
        tenantId: null,
      });
    } catch (err) {
      // On re-run the setup token has already been used; continue and verify via login below.
      if (!(isApiError(err) && (err.code === "unauthorized" || err.code === "validation_error"))) throw err;
    }
  }

  const superMfa = await loginAndSatisfyMfa(superClient, SUPER_EMAIL, SUPER_PASSWORD, prev?.superAdmin?.totpSecret);

  // 3. Provision Alliance High School (or skip on 409 if already provisioned).
  let tenantId = prev?.tenantId ?? "";
  let adminInviteToken: string | null = null;
  try {
    const created = await superClient.post("/v1/platform/schools", {
      body: {
        organization_name: "Alliance Schools Kenya",
        school_name: SCHOOL_NAME,
        slug: SCHOOL_SLUG,
        admin_email: ADMIN_EMAIL,
        admin_name: ADMIN_NAME,
      },
      tenantId: null,
    });
    tenantId = created.school.tenant_id;
    adminInviteToken = created.invitation.token ?? null;
  } catch (err) {
    if (!(isApiError(err) && err.code === "conflict")) throw err;
  }

  // 4. Accept the school admin invitation (if freshly issued), then sign in as principal + enrol TOTP.
  const adminClient = makeClient();
  if (adminInviteToken) {
    await adminClient.post("/v1/invitations/accept", {
      body: { token: adminInviteToken, password: ADMIN_PASSWORD, full_name: ADMIN_NAME },
      auth: false,
      tenantId: null,
    });
  }

  const adminMfa = await loginAndSatisfyMfa(adminClient, ADMIN_EMAIL, ADMIN_PASSWORD, prev?.admin?.totpSecret);
  const adminTotpSecret = adminMfa.totpSecret ?? prev?.admin?.totpSecret ?? "";
  const adminRecoveryCodes = adminMfa.recoveryCodes.length > 0 ? adminMfa.recoveryCodes : (prev?.admin?.recoveryCodes ?? []);

  if (!tenantId) {
    const me = await adminClient.get("/v1/auth/me", { tenantId: null });
    const match = me.memberships.find((m) => Boolean(m.tenantId));
    if (!match?.tenantId) throw new Error(`Could not resolve tenantId for ${SCHOOL_SLUG} from /v1/auth/me.`);
    tenantId = match.tenantId;
  }
  adminClient.setActiveTenant(tenantId);

  // 5. Update school profile details.
  await adminClient.patch("/v1/tenants/{tenantId}/school-profile", {
    path: { tenantId },
    body: { name: SCHOOL_NAME, county: "Kiambu", moe_registration: "MOE/SEC/001" },
    tenantId,
  });

  // 6. Invite & activate demo teacher account (idempotent on 409).
  try {
    const inv = await adminClient.post("/v1/tenants/{tenantId}/invitations", {
      path: { tenantId },
      body: { email: TEACHER_EMAIL, role: "teacher", full_name: TEACHER_NAME },
      tenantId,
    });
    if (inv.invitation.token) {
      const teacherClient = makeClient();
      await teacherClient.post("/v1/invitations/accept", {
        body: { token: inv.invitation.token, password: TEACHER_PASSWORD, full_name: TEACHER_NAME },
        auth: false,
        tenantId: null,
      });
    }
  } catch (err) {
    if (!(isApiError(err) && err.code === "conflict")) throw err;
  }

  // Resolve the demo teacher's user ID so the staff directory record links to their sign-in account.
  const teacherLoginClient = makeClient();
  const teacherLogin = await teacherLoginClient.post("/v1/auth/login/email", {
    body: { email: TEACHER_EMAIL, password: TEACHER_PASSWORD },
    auth: false,
    tenantId: null,
  });
  const teacherUserId = teacherLogin.user.id;

  // Also ensure a teacher staff directory record exists and is linked to the teacher's user account (idempotent).
  const existingStaff = await listAllPages(async (cursor) => {
    const r = await adminClient.get("/v1/tenants/{tenantId}/staff", {
      path: { tenantId },
      query: { limit: 100, cursor },
      tenantId,
    });
    return { items: r.staff, page: r.page };
  });
  const teacherStaff = existingStaff.find((s) => s.full_name === TEACHER_NAME) ?? null;
  let teacherStaffId = teacherStaff?.id ?? null;
  if (!teacherStaffId) {
    const made = await adminClient.post("/v1/tenants/{tenantId}/staff", {
      path: { tenantId },
      body: {
        full_name: TEACHER_NAME,
        classification: "teacher",
        staff_title: "Senior Mathematics Teacher",
        email: TEACHER_EMAIL,
        userId: teacherUserId,
      },
      tenantId,
    });
    teacherStaffId = made.staff.id;
  } else if (teacherStaff && teacherStaff.userId !== teacherUserId) {
    await adminClient.patch("/v1/tenants/{tenantId}/staff/{staffId}", {
      path: { tenantId, staffId: teacherStaffId },
      body: { userId: teacherUserId },
      tenantId,
    });
  }

  // 7. Academic year & current term (2026 / Term 1).
  const years = await listAllPages(async (cursor) => {
    const r = await adminClient.get("/v1/tenants/{tenantId}/academic-years", {
      path: { tenantId },
      query: { limit: 100, cursor },
      tenantId,
    });
    return { items: r.academic_years, page: r.page };
  });
  let year = years.find((y) => y.label === "2026");
  if (!year) {
    year = (await adminClient.post("/v1/tenants/{tenantId}/academic-years", {
      path: { tenantId },
      body: { label: "2026", starts_on: "2026-01-01", ends_on: "2026-12-31" },
      tenantId,
    })).academic_year;
  }
  if (!year.is_current) {
    await adminClient.post("/v1/tenants/{tenantId}/academic-years/{academicYearId}/set-current", {
      path: { tenantId, academicYearId: year.id },
      tenantId,
    });
  }

  const terms = await listAllPages(async (cursor) => {
    const r = await adminClient.get("/v1/tenants/{tenantId}/academic-terms", {
      path: { tenantId },
      query: { academicYearId: year.id, limit: 100, cursor },
      tenantId,
    });
    return { items: r.terms, page: r.page };
  });
  let term = terms.find((t) => t.index === 1);
  if (!term) {
    term = (await adminClient.post("/v1/tenants/{tenantId}/academic-terms", {
      path: { tenantId },
      body: {
        academic_year_id: year.id,
        index: 1,
        label: "Term 1, 2026",
        starts_on: "2026-01-06",
        ends_on: "2026-04-03",
      },
      tenantId,
    })).term;
  }
  if (!term.is_current) {
    await adminClient.post("/v1/tenants/{tenantId}/academic-terms/{termId}/set-current", {
      path: { tenantId, termId: term.id },
      tenantId,
    });
  }

  // 8. Classes (Form 1 East, Form 2 West).
  const existingClasses = await listAllPages(async (cursor) => {
    const r = await adminClient.get("/v1/tenants/{tenantId}/classes", {
      path: { tenantId },
      query: { academicYearId: year.id, limit: 100, cursor },
      tenantId,
    });
    return { items: r.classes, page: r.page };
  });
  const classIds = new Map(existingClasses.map((c) => [c.name, c.id]));
  const wantedClasses = [
    { name: "Form 1 East", form_level: 1, stream: "East", class_teacher_staff_id: teacherStaffId },
    { name: "Form 2 West", form_level: 2, stream: "West", class_teacher_staff_id: null },
  ] as const;
  for (const c of wantedClasses) {
    if (!classIds.has(c.name)) {
      const made = await adminClient.post("/v1/tenants/{tenantId}/classes", {
        path: { tenantId },
        body: {
          academic_year_id: year.id,
          name: c.name,
          education_level: "secondary",
          form_level: c.form_level,
          pathway: null,
          stream: c.stream,
          class_teacher_staff_id: c.class_teacher_staff_id,
        },
        tenantId,
      });
      classIds.set(c.name, made.school_class.id);
    }
  }

  // 9. Subjects (Mathematics, English).
  const existingSubjects = await listAllPages(async (cursor) => {
    const r = await adminClient.get("/v1/tenants/{tenantId}/subjects", {
      path: { tenantId },
      query: { limit: 100, cursor },
      tenantId,
    });
    return { items: r.subjects, page: r.page };
  });
  const subjectCodes = new Set(existingSubjects.map((s) => s.code));
  const wantedSubjects = [
    { code: "MATH", name: "Mathematics" },
    { code: "ENG", name: "English" },
  ] as const;
  for (const s of wantedSubjects) {
    if (!subjectCodes.has(s.code)) {
      await adminClient.post("/v1/tenants/{tenantId}/subjects", {
        path: { tenantId },
        body: { code: s.code, name: s.name },
        tenantId,
      });
    }
  }

  // 10. Learners + class memberships.
  const existingLearners = await listAllPages(async (cursor) => {
    const r = await adminClient.get("/v1/tenants/{tenantId}/learners", {
      path: { tenantId },
      query: { limit: 100, cursor },
      tenantId,
    });
    return { items: r.learners, page: r.page };
  });
  const learnerByAdm = new Map(existingLearners.map((l) => [l.admission_no, l.id]));
  const existingMemberships = await listAllPages(async (cursor) => {
    const r = await adminClient.get("/v1/tenants/{tenantId}/class-memberships", {
      path: { tenantId },
      query: { active: true, limit: 100, cursor },
      tenantId,
    });
    return { items: r.memberships, page: r.page };
  });
  const placedLearners = new Set(existingMemberships.map((m) => m.learner_id));

  const wantedLearners = [
    { admission_no: "ADM-1001", full_name: "Amina Ochieng", gender: "female" as const, boarding: false, date_of_birth: "2011-03-14", cls: "Form 1 East" },
    { admission_no: "ADM-1002", full_name: "Brian Kamau", gender: "male" as const, boarding: true, date_of_birth: "2010-08-22", cls: "Form 2 West" },
  ];
  for (const l of wantedLearners) {
    let learnerId = learnerByAdm.get(l.admission_no);
    if (!learnerId) {
      const made = await adminClient.post("/v1/tenants/{tenantId}/learners", {
        path: { tenantId },
        body: {
          admission_no: l.admission_no,
          full_name: l.full_name,
          gender: l.gender,
          boarding: l.boarding,
          date_of_birth: l.date_of_birth,
        },
        tenantId,
      });
      learnerId = made.learner.id;
      learnerByAdm.set(l.admission_no, learnerId);
    }
    const classId = classIds.get(l.cls);
    if (classId && !placedLearners.has(learnerId)) {
      await adminClient.post("/v1/tenants/{tenantId}/class-memberships", {
        path: { tenantId },
        body: { learner_id: learnerId, class_id: classId },
        tenantId,
      });
      placedLearners.add(learnerId);
    }
  }

  // 11. Fee item for current term.
  const existingFeeItems = await listAllPages(async (cursor) => {
    const r = await adminClient.get("/v1/tenants/{tenantId}/finance/fee-items", {
      path: { tenantId },
      query: { termId: term.id, limit: 100, cursor },
      tenantId,
    });
    return { items: r.fee_items, page: r.page };
  });
  if (!existingFeeItems.some((f) => f.name === "Tuition")) {
    await adminClient.post("/v1/tenants/{tenantId}/finance/fee-items", {
      path: { tenantId },
      body: {
        term_id: term.id,
        name: "Tuition",
        amount_minor: 2_500_000, // KES 25,000.00
        applies_to: "all",
        form_level: null,
      },
      tenantId,
    });
  }

  // 12. Published announcement.
  const existingAnnouncements = await adminClient.get("/v1/tenants/{tenantId}/communications/announcements", {
    path: { tenantId },
    query: { published: "true", limit: 20 },
    tenantId,
  });
  const welcomeSubject = "Welcome to Term 1";
  if (!existingAnnouncements.announcements.some((a) => a.subject === welcomeSubject)) {
    const draft = await adminClient.post("/v1/tenants/{tenantId}/communications/announcements", {
      path: { tenantId },
      body: {
        subject: welcomeSubject,
        body: "Term 1 opens Monday at 7:30 am. Please ensure learners report in full uniform.",
        audience: { kind: "whole_school" },
        channels: ["in_app"],
      },
      tenantId,
    });
    await adminClient.post("/v1/tenants/{tenantId}/communications/announcements/{announcementId}/publish", {
      path: { tenantId, announcementId: draft.announcement.id },
      tenantId,
    });
  }

  // 13. Write seed state (including TOTP secret for E2E) to OUTPUT_PATH (gitignored).
  const output: SeedOutput = {
    apiUrl: API_URL,
    tenantId,
    slug: SCHOOL_SLUG,
    schoolName: SCHOOL_NAME,
    superAdmin: {
      email: SUPER_EMAIL,
      password: SUPER_PASSWORD,
      totpSecret: superMfa.totpSecret ?? prev?.superAdmin?.totpSecret ?? null,
    },
    admin: {
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      totpSecret: adminTotpSecret,
      recoveryCodes: adminRecoveryCodes,
    },
    teacher: {
      email: TEACHER_EMAIL,
      password: TEACHER_PASSWORD,
    },
    seeded: {
      academicYear: "2026",
      term: "Term 1, 2026",
      classes: wantedClasses.map((c) => c.name),
      subjects: wantedSubjects.map((s) => s.name),
      learners: wantedLearners.map((l) => l.full_name),
      feeItems: ["Tuition"],
      announcements: [welcomeSubject],
    },
  };

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2) + "\n", { mode: 0o600 });
  console.log(`API demo seed complete: ${SCHOOL_NAME} (${SCHOOL_SLUG}, tenant ${tenantId}). Seed state written to ${OUTPUT_PATH}.`);
}

main().catch((err) => {
  console.error("API demo seed failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
