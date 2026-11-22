import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type FixtureIds } from "./support.js";

/**
 * Vertical slice: school curriculum → assessment → rubric → results → progress →
 * competencies → report card figures. Also checks OD-2 teacher CBE read scope.
 */
describe("Stage 9 CBE engine completion (migration 079)", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let ids: FixtureIds;
  let adminToken: string;
  let teacherToken: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    ids = ctx.ids;
    adminToken = (
      await ctx.app.inject({
        method: "POST",
        url: "/v1/auth/login/email",
        payload: { email: "admin-a@example.com", password: "correct-horse-battery" },
      })
    ).json().token;
    teacherToken = (
      await ctx.app.inject({
        method: "POST",
        url: "/v1/auth/login/login-id",
        payload: { tenantId: ids.tenantA, loginId: "TC-0001", password: "correct-horse-battery" },
      })
    ).json().token;
  }, 120_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  async function admin(method: "GET" | "POST", url: string, payload?: Record<string, unknown>) {
    const res = await ctx.app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": ids.tenantA,
        ...(payload ? { "idempotency-key": randomUUID() } : {}),
      },
      ...(payload === undefined ? {} : { payload }),
    });
    return res;
  }

  it("runs the CBC workflow and scopes teacher CBE reads", async () => {
    const year = await admin("POST", `/v1/tenants/${ids.tenantA}/academic-years`, {
      label: "CBE Year",
      starts_on: "2020-01-01",
      ends_on: "2035-12-31",
    });
    expect(year.statusCode).toBe(201);
    const yearId = year.json().academic_year.id as string;

    const term = await admin("POST", `/v1/tenants/${ids.tenantA}/academic-terms`, {
      academic_year_id: yearId,
      index: 1,
      label: "T1",
      starts_on: "2020-01-01",
      ends_on: "2035-12-31",
    });
    expect(term.statusCode).toBe(201);
    const termId = term.json().term.id as string;

    const klass = await admin("POST", `/v1/tenants/${ids.tenantA}/classes`, {
      academic_year_id: yearId,
      name: "CBE Grade 4",
      form_level: 4,
      education_level: "primary",
    });
    expect(klass.statusCode).toBe(201);
    expect(klass.json().school_class.education_level).toBe("primary");
    const classId = klass.json().school_class.id as string;

    const other = await admin("POST", `/v1/tenants/${ids.tenantA}/classes`, {
      academic_year_id: yearId,
      name: "Other class",
      form_level: 5,
      education_level: "primary",
    });
    const otherClassId = other.json().school_class.id as string;

    const learner = await admin("POST", `/v1/tenants/${ids.tenantA}/learners`, {
      admission_no: "CBE-001",
      full_name: "CBE Learner",
      gender: "female",
    });
    const learnerId = learner.json().learner.id as string;
    await admin("POST", `/v1/tenants/${ids.tenantA}/class-memberships`, {
      learner_id: learnerId,
      class_id: classId,
    });

    const staff = await admin("POST", `/v1/tenants/${ids.tenantA}/staff`, {
      full_name: "CBE Teacher",
      classification: "teacher",
      userId: ids.teacherA,
    });
    const subject = await admin("POST", `/v1/tenants/${ids.tenantA}/subjects`, { code: "ENG", name: "English" });
    await admin("POST", `/v1/tenants/${ids.tenantA}/teaching-assignments`, {
      staff_member_id: staff.json().staff.id,
      class_id: classId,
      subject_id: subject.json().subject.id,
    });

    const ref = await admin("GET", `/v1/tenants/${ids.tenantA}/curriculum-reference?entryKind=core_competency`);
    expect(ref.statusCode).toBe(200);
    expect(ref.json().official_catalogue).toBe(false);
    expect(ref.json().entries.length).toBeGreaterThanOrEqual(7);

    const prov = await admin("POST", `/v1/tenants/${ids.tenantA}/curriculum-provenance`, {
      source_kind: "school_configured",
      source_label: "School CBC pack",
    });
    const provenanceId = prov.json().provenance.id as string;
    const area = await admin("POST", `/v1/tenants/${ids.tenantA}/learning-areas`, {
      provenance_id: provenanceId,
      code: "ENG",
      name: "English Activities",
    });
    const areaId = area.json().learning_area.id as string;
    const strand = await admin("POST", `/v1/tenants/${ids.tenantA}/strands`, {
      learning_area_id: areaId,
      code: "LIST",
      name: "Listening",
    });
    const strandId = strand.json().strand.id as string;
    const sub = await admin("POST", `/v1/tenants/${ids.tenantA}/sub-strands`, {
      strand_id: strandId,
      code: "ATT",
      name: "Attention",
    });
    const outcome = await admin("POST", `/v1/tenants/${ids.tenantA}/learning-outcomes`, {
      sub_strand_id: sub.json().sub_strand.id,
      code: "LO1",
      statement: "Listens attentively",
    });
    const outcomeId = outcome.json().learning_outcome.id as string;

    const rubric = await admin("POST", `/v1/tenants/${ids.tenantA}/rubric-configs`, {
      name: "Qualitative",
      scoring_mode: "level_only",
      descriptors: [
        { level_code: "EE", label: "Exceeding" },
        { level_code: "ME", label: "Meeting" },
        { level_code: "AE", label: "Approaching" },
        { level_code: "BE", label: "Below" },
      ],
    });
    expect(rubric.statusCode).toBe(201);
    expect(rubric.json().rubric_config.scoring_mode).toBe("level_only");
    const rubricId = rubric.json().rubric_config.id as string;

    const cbe = await admin("POST", `/v1/tenants/${ids.tenantA}/cbe-assessments`, {
      class_id: classId,
      learning_area_id: areaId,
      term_id: termId,
      title: "Listening observation",
      instrument_type: "observation",
      rubric_config_id: rubricId,
      assessment_date: "2026-03-01",
      instructions: "Observe during story time",
      strand_id: strandId,
      learning_outcome_id: outcomeId,
      curriculum_version_label: "school-2026",
    });
    expect(cbe.statusCode).toBe(201);
    expect(cbe.json().cbe_assessment.status).toBe("draft");
    expect(cbe.json().cbe_assessment.instrument_type).toBe("observation");
    const cbeId = cbe.json().cbe_assessment.id as string;

    const otherCbe = await admin("POST", `/v1/tenants/${ids.tenantA}/cbe-assessments`, {
      class_id: otherClassId,
      learning_area_id: areaId,
      term_id: termId,
      title: "Hidden",
      rubric_config_id: rubricId,
    });
    const otherCbeId = otherCbe.json().cbe_assessment.id as string;

    const result = await admin("POST", `/v1/tenants/${ids.tenantA}/cbe-assessments/${cbeId}/results`, {
      learner_id: learnerId,
      learning_outcome_id: outcomeId,
      level_code: "ME",
      observation: "Followed the story with prompts",
      teacher_feedback: "Continue paired reading",
      completion_status: "reviewed",
    });
    expect(result.statusCode).toBe(201);
    expect(result.json().result.observation).toContain("story");
    expect(result.json().result.points).toBeDefined();

    const pub = await admin("POST", `/v1/tenants/${ids.tenantA}/cbe-assessments/${cbeId}/publish`);
    expect(pub.statusCode).toBe(200);
    expect(pub.json().cbe_assessment.status).toBe("published");

    const rating = await admin("POST", `/v1/tenants/${ids.tenantA}/competency-ratings`, {
      term_id: termId,
      learner_id: learnerId,
      kind: "competency",
      item: "communication",
      level_code: "EE",
    });
    expect(rating.statusCode).toBe(201);

    const progress = await admin(
      "GET",
      `/v1/tenants/${ids.tenantA}/learners/${learnerId}/cbe-progress?termId=${termId}`,
    );
    expect(progress.statusCode).toBe(200);
    expect(progress.json().progress.outcomes.length).toBeGreaterThanOrEqual(1);
    expect(progress.json().progress.outcomes[0].latest_level_code).toBe("ME");

    const report = await admin("POST", `/v1/tenants/${ids.tenantA}/report-cards`, {
      term_id: termId,
      class_id: classId,
    });
    expect(report.statusCode).toBe(201);
    const figures = report.json().report_card.figures;
    expect(figures.cbe.assessment_ids).toContain(cbeId);
    expect(figures.cbe.learners[0].results[0].title).toBe("Listening observation");
    expect(figures.cbe.learners[0].results[0].instrument_type).toBe("observation");
    expect(figures.competencies.learners[0].ratings[0].item).toBe("communication");

    // M-2: revising a CBE result snapshots qualitative fields in cbe_result_revisions.
    const revised = await admin("POST", `/v1/tenants/${ids.tenantA}/cbe-assessments/${cbeId}/results`, {
      learner_id: learnerId,
      learning_outcome_id: outcomeId,
      level_code: "EE",
      observation: "Independent storytelling",
      teacher_feedback: "Ready for peer mentoring",
      completion_status: "finalized",
      row_version: 1,
      reason: "updated after review",
    });
    expect(revised.statusCode).toBe(200);
    const revRow = await ctx.pool.query<{
      previous_observation: string | null;
      new_observation: string | null;
      previous_completion_status: string | null;
      new_completion_status: string | null;
    }>(
      `SELECT previous_observation, new_observation, previous_completion_status, new_completion_status
         FROM cbe_result_revisions WHERE result_id = $1 ORDER BY resulting_row_version DESC LIMIT 1`,
      [revised.json().result.id],
    );
    expect(revRow.rows[0]).toEqual({
      previous_observation: "Followed the story with prompts",
      new_observation: "Independent storytelling",
      previous_completion_status: "reviewed",
      new_completion_status: "finalized",
    });

    // M-3: updating a competency rating appends to learner_competency_rating_revisions.
    const ratingUpdate = await admin("POST", `/v1/tenants/${ids.tenantA}/competency-ratings`, {
      term_id: termId,
      learner_id: learnerId,
      kind: "competency",
      item: "communication",
      level_code: "ME",
      row_version: 1,
    });
    expect(ratingUpdate.statusCode).toBe(200);
    const compRev = await ctx.pool.query<{ previous_level_code: string; new_level_code: string; resulting_row_version: number }>(
      `SELECT previous_level_code, new_level_code, resulting_row_version
         FROM learner_competency_rating_revisions WHERE rating_id = $1`,
      [rating.json().rating.id],
    );
    expect(compRev.rows[0]).toEqual({ previous_level_code: "EE", new_level_code: "ME", resulting_row_version: 2 });

    // WS-3: concurrent timetable slot overlap serialization + optional grading scheme on report card.
    const [slotA, slotB] = await Promise.all([
      admin("POST", `/v1/tenants/${ids.tenantA}/timetable-slots`, {
        class_id: classId,
        subject_id: subject.json().subject.id,
        day_of_week: 1,
        starts_at: "08:00",
        ends_at: "09:00",
      }),
      admin("POST", `/v1/tenants/${ids.tenantA}/timetable-slots`, {
        class_id: classId,
        subject_id: subject.json().subject.id,
        day_of_week: 1,
        starts_at: "08:30",
        ends_at: "09:30",
      }),
    ]);
    expect([slotA.statusCode, slotB.statusCode].sort()).toEqual([201, 409]);

    const scheme = await admin("POST", `/v1/tenants/${ids.tenantA}/grading-schemes`, {
      name: "CBC Numeric Band",
      rules: { bands: [{ min: 0, max: 50, grade: "BE" }, { min: 50, max: 100, grade: "EE" }] },
    });
    expect(scheme.statusCode).toBe(201);
    const numAssess = await admin("POST", `/v1/tenants/${ids.tenantA}/assessments`, {
      class_id: classId,
      subject_id: subject.json().subject.id,
      term_id: termId,
      title: "Midterm",
      kind: "exam",
      max_score: 100,
    });
    expect(numAssess.statusCode).toBe(201);
    await admin("POST", `/v1/tenants/${ids.tenantA}/assessments/${numAssess.json().assessment.id}/marks`, {
      learner_id: learnerId,
      score: 80,
    });
    await admin("POST", `/v1/tenants/${ids.tenantA}/assessments/${numAssess.json().assessment.id}/publish`);
    const gradedReport = await admin("POST", `/v1/tenants/${ids.tenantA}/report-cards`, {
      term_id: termId,
      class_id: classId,
      grading_scheme_id: scheme.json().scheme.id,
    });
    expect(gradedReport.statusCode).toBe(201);
    expect(gradedReport.json().report_card.figures.grading_scheme_id).toBe(scheme.json().scheme.id);
    expect(gradedReport.json().report_card.figures.learners[0].grade).toBe("EE");

    const teacherList = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/cbe-assessments`,
      headers: { authorization: `Bearer ${teacherToken}`, "x-tenant-id": ids.tenantA },
    });
    expect(teacherList.statusCode).toBe(200);
    const listed = teacherList.json().cbe_assessments.map((a: { id: string }) => a.id);
    expect(listed).toContain(cbeId);
    expect(listed).not.toContain(otherCbeId);

    const teacherHidden = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/cbe-assessments/${otherCbeId}`,
      headers: { authorization: `Bearer ${teacherToken}`, "x-tenant-id": ids.tenantA },
    });
    expect(teacherHidden.statusCode).toBe(404);

    const closed = await admin("POST", `/v1/tenants/${ids.tenantA}/cbe-assessments/${cbeId}/close`);
    expect(closed.statusCode).toBe(200);
    expect(closed.json().cbe_assessment.status).toBe("closed");

    const blocked = await admin("POST", `/v1/tenants/${ids.tenantA}/cbe-assessments/${cbeId}/results`, {
      learner_id: learnerId,
      learning_outcome_id: outcomeId,
      level_code: "EE",
      row_version: 1,
      reason: "too late",
    });
    expect(blocked.statusCode).toBe(409);

    // H-1: database refuses draft → closed shortcut.
    const draft = await admin("POST", `/v1/tenants/${ids.tenantA}/cbe-assessments`, {
      class_id: classId,
      learning_area_id: areaId,
      term_id: termId,
      title: "Draft only",
      rubric_config_id: rubricId,
    });
    const draftId = draft.json().cbe_assessment.id as string;
    const shortcut = await ctx.pool.query(
      `UPDATE cbe_assessments
          SET status = 'closed', published_at = now(), closed_at = now(), row_version = row_version + 1
        WHERE id = $1 AND status = 'draft'
      RETURNING id`,
      [draftId],
    ).catch((err: { code?: string }) => err);
    expect((shortcut as { code?: string }).code).toBe("23514");

    // H-4: teacher cannot read progress for learners outside taught classes.
    const otherLearner = await admin("POST", `/v1/tenants/${ids.tenantA}/learners`, {
      admission_no: "CBE-002",
      full_name: "Other Learner",
      gender: "male",
    });
    const otherLearnerId = otherLearner.json().learner.id as string;
    await admin("POST", `/v1/tenants/${ids.tenantA}/class-memberships`, {
      learner_id: otherLearnerId,
      class_id: otherClassId,
    });
    const progressDenied = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/learners/${otherLearnerId}/cbe-progress?termId=${termId}`,
      headers: { authorization: `Bearer ${teacherToken}`, "x-tenant-id": ids.tenantA },
    });
    expect(progressDenied.statusCode).toBe(404);

    // Report-card list OD-2: out-of-scope class and missing classId are indistinguishable (empty page).
    const rcScoped = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/report-cards?classId=${otherClassId}`,
      headers: { authorization: `Bearer ${teacherToken}`, "x-tenant-id": ids.tenantA },
    });
    expect(rcScoped.statusCode).toBe(200);
    expect(rcScoped.json().report_cards).toEqual([]);
    const rcMissing = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/report-cards?classId=${randomUUID()}`,
      headers: { authorization: `Bearer ${teacherToken}`, "x-tenant-id": ids.tenantA },
    });
    expect(rcMissing.statusCode).toBe(200);
    expect(rcMissing.json().report_cards).toEqual([]);
    const rcOwn = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantA}/report-cards?classId=${classId}`,
      headers: { authorization: `Bearer ${teacherToken}`, "x-tenant-id": ids.tenantA },
    });
    expect(rcOwn.statusCode).toBe(200);
    expect(rcOwn.json().report_cards.length).toBeGreaterThanOrEqual(1);
  });

  it("rejects learning_area pathway unless education_level is senior_school (SQL CHECK)", async () => {
    const prov = await admin("POST", `/v1/tenants/${ids.tenantA}/curriculum-provenance`, {
      source_kind: "school_configured",
      source_label: "Pathway check provenance",
    });
    expect(prov.statusCode).toBe(201);
    const provenanceId = prov.json().provenance.id as string;
    const apiReject = await admin("POST", `/v1/tenants/${ids.tenantA}/learning-areas`, {
      provenance_id: provenanceId,
      code: "PATHAPI",
      name: "Path via API",
      education_level: "primary",
      pathway: "stem",
    });
    expect(apiReject.statusCode).toBe(400);
    const sqlReject = await ctx.pool
      .query(
        `INSERT INTO learning_areas
           (tenant_id, provenance_id, code, name, education_level, pathway)
         VALUES ($1, $2, 'PATHSQL', 'Path via SQL', 'primary', 'stem')`,
        [ids.tenantA, provenanceId],
      )
      .catch((err: { code?: string }) => err);
    expect((sqlReject as { code?: string }).code).toBe("23514");
  });
});
