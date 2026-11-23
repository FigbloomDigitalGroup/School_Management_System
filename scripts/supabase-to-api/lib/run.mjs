// Carries one school's plan out against apps/api, in the order the API needs: the school, its years and terms,
// staff, classes, learners, class placements, guardians and links, and last the archiving (an archived learner
// can no longer be placed, linked or marked, so nothing is archived until everything else is in).
//
// Resumable and safe to re-run: every created record goes in the ledger, every create carries a deterministic
// Idempotency-Key, and a record the API already holds (a lost ledger) is adopted by its natural key rather than
// duplicated. Staff and guardians have no natural key, so with no ledger entry and records already in the API the
// run stops instead of risking copies.
import { appendFileSync } from "node:fs";
import { ApiError } from "./api.mjs";

const T = (tenantId) => `/v1/tenants/${tenantId}`;
const idem = (key) => `mig:${key}`;

export function describe(e) {
  if (e instanceof ApiError) {
    return { status: e.status, code: e.code, message: e.message, requestId: e.requestId, details: e.details };
  }
  return { message: e?.message ?? String(e) };
}

export async function applySchool(ctx, plan) {
  const { api, ledger, adopt = {}, secretsFile = null, log = () => {} } = ctx;
  const { school } = plan;
  const stats = {};
  const failures = [];
  const stat = (kind) => (stats[kind] ??= { created: 0, adopted: 0, skipped: 0, failed: 0, parentFailed: 0 });
  const fail = (kind, key, e) => {
    stat(kind).failed += 1;
    failures.push({ kind, key, ...describe(e) });
  };
  const result = (extra = {}) => ({ school: school.slug, tenantId: ledger.get(`tenant:${school.sourceId}`) ?? null, stats, failures, ...extra });

  if (plan.blocked.some((b) => b.kind === "school")) {
    return result({ stopped: "the school itself is blocked; see the plan report" });
  }

  /** Create unless the ledger has it. A 409 on a placement or link means it is already there. */
  async function ensure(kind, key, create, { conflictIsDone = false } = {}) {
    const have = ledger.get(key);
    if (have) {
      stat(kind).skipped += 1;
      return have;
    }
    try {
      const id = await create();
      ledger.set(key, id);
      stat(kind).created += 1;
      return id;
    } catch (e) {
      if (conflictIsDone && e instanceof ApiError && e.status === 409) {
        ledger.set(key, "existing");
        stat(kind).adopted += 1;
        return "existing";
      }
      fail(kind, key, e);
      return null;
    }
  }

  /** Match records the API already holds to planned ones by natural key, when the ledger does not know them. */
  async function adoptByNaturalKey(kind, items, tenantId, path, envelope, planKey, existingKey) {
    if (!items.some((i) => !ledger.has(i.key))) return;
    const existing = await api.listAll(`${T(tenantId)}${path}`, envelope, { tenantId });
    const byKey = new Map(existing.map((e) => [existingKey(e), e.id]));
    for (const item of items) {
      if (ledger.has(item.key)) continue;
      const id = byKey.get(planKey(item));
      if (id) {
        ledger.set(item.key, id);
        stat(kind).adopted += 1;
      }
    }
  }

  /** Staff and guardians cannot be matched: if the API already has some and we have no record of making them, stop. */
  async function refuseIfUnknownRecordsExist(kind, items, tenantId, path, envelope) {
    if (!items.some((i) => !ledger.has(i.key)) || ledger.hasAny(items.map((i) => i.key))) return;
    const existing = await api.listAll(`${T(tenantId)}${path}`, envelope, { tenantId, query: {} });
    if (existing.length > 0) {
      throw new Error(
        `The API already holds ${existing.length} ${kind} for ${school.slug} that this run's ledger does not know. ` +
          `Running on would copy them. Restore the ledger, or clear the school in the API, then run again.`,
      );
    }
  }

  // ---- 1. the school ----
  let tenantId = ledger.get(`tenant:${school.sourceId}`);
  if (!tenantId && adopt[school.slug]) {
    tenantId = adopt[school.slug];
    ledger.set(`tenant:${school.sourceId}`, tenantId);
    stat("school").adopted += 1;
  }
  if (!tenantId) {
    const org = plan.provision.organization;
    const orgId = org ? ledger.get(`org:${org.sourceId}`) : undefined;
    const body = {
      school_name: plan.provision.school_name,
      slug: plan.provision.slug,
      admin_email: plan.provision.admin_email,
      ...(plan.provision.admin_name ? { admin_name: plan.provision.admin_name } : {}),
      ...(orgId ? { organization_id: orgId } : { organization_name: org.name }),
    };
    try {
      await api.reauth();
      const res = await api.request("POST", "/v1/platform/schools", { body });
      tenantId = res.body.school.tenant_id;
      ledger.set(`tenant:${school.sourceId}`, tenantId);
      if (org) ledger.set(`org:${org.sourceId}`, res.body.school.organization_id);
      const inv = res.body.invitation;
      if (inv?.token && secretsFile) {
        // The only time the API shows this token. It lets the first school administrator set a password.
        appendFileSync(
          secretsFile,
          `${JSON.stringify({ slug: school.slug, email: plan.provision.admin_email, token: inv.token, expires_at: inv.expires_at })}\n`,
          { mode: 0o600 },
        );
      }
      stat("school").created += 1;
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        throw new Error(`A school with slug "${school.slug}" already exists in the API. Re-run with --adopt ${school.slug}=<its tenant id> to copy into it.`);
      }
      throw e;
    }
  } else {
    stat("school").skipped += 1;
  }
  log(`  school ${school.slug}: ready`);

  // ---- 2. school profile fields ----
  if (Object.keys(plan.profilePatch).length > 0 && !ledger.has(`profile:${school.sourceId}`)) {
    try {
      if (plan.profilePatch.timezone) await api.reauth();
      await api.request("PATCH", `${T(tenantId)}/school-profile`, { tenantId, body: plan.profilePatch });
      ledger.set(`profile:${school.sourceId}`, "done");
      stat("school_profile").created += 1;
    } catch (e) {
      fail("school_profile", `profile:${school.sourceId}`, e);
    }
  }

  // ---- 3. academic years and terms ----
  const yearId = new Map();
  await adoptByNaturalKey("academic_years", plan.years, tenantId, "/academic-years", "academic_years", (y) => y.body.label, (e) => e.label);
  for (const y of plan.years) {
    const id = await ensure("academic_years", y.key, async () =>
      (await api.request("POST", `${T(tenantId)}/academic-years`, { tenantId, body: y.body, idempotencyKey: idem(y.key) })).body.academic_year.id);
    if (id) yearId.set(y.key, id);
  }
  log(`  academic years: ${stat("academic_years").created} new`);

  const termsReady = plan.terms.filter((t) => yearId.has(t.yearKey));
  for (const t of plan.terms) if (!yearId.has(t.yearKey)) stat("terms").parentFailed += 1;
  // A term's natural key is (year, index): match through the year id.
  if (termsReady.some((t) => !ledger.has(t.key))) {
    const existing = await api.listAll(`${T(tenantId)}/academic-terms`, "terms", { tenantId });
    const byKey = new Map(existing.map((e) => [`${e.academic_year_id}:${e.index}`, e.id]));
    for (const t of termsReady) {
      const id = byKey.get(`${yearId.get(t.yearKey)}:${t.body.index}`);
      if (!ledger.has(t.key) && id) {
        ledger.set(t.key, id);
        stat("terms").adopted += 1;
      }
    }
  }
  for (const t of termsReady) {
    await ensure("terms", t.key, async () =>
      (await api.request("POST", `${T(tenantId)}/academic-terms`, {
        tenantId,
        body: { academic_year_id: yearId.get(t.yearKey), ...t.body },
        idempotencyKey: idem(t.key),
      })).body.term.id);
  }
  log(`  terms: ${stat("terms").created} new`);

  // ---- 4. staff (directory records; logins come from invitations, a separate decision) ----
  await refuseIfUnknownRecordsExist("staff", plan.staff, tenantId, "/staff", "staff");
  for (const s of plan.staff) {
    await ensure("staff", s.key, async () =>
      (await api.request("POST", `${T(tenantId)}/staff`, { tenantId, body: s.body, idempotencyKey: idem(s.key) })).body.staff.id);
  }
  log(`  staff: ${stat("staff").created} new`);

  // ---- 5. classes ----
  const classesReady = plan.classes.filter((c) => yearId.has(c.yearKey));
  for (const c of plan.classes) if (!yearId.has(c.yearKey)) stat("classes").parentFailed += 1;
  if (classesReady.some((c) => !ledger.has(c.key))) {
    const existing = await api.listAll(`${T(tenantId)}/classes`, "classes", { tenantId });
    const byName = new Map(existing.map((e) => [`${e.academic_year_id}:${String(e.name).trim().toLowerCase()}`, e.id]));
    for (const c of classesReady) {
      const id = byName.get(`${yearId.get(c.yearKey)}:${c.body.name.toLowerCase()}`);
      if (!ledger.has(c.key) && id) {
        ledger.set(c.key, id);
        stat("classes").adopted += 1;
      }
    }
  }
  for (const c of classesReady) {
    const teacher = c.teacherStaffKey ? ledger.get(c.teacherStaffKey) : undefined;
    await ensure("classes", c.key, async () =>
      (await api.request("POST", `${T(tenantId)}/classes`, {
        tenantId,
        body: { academic_year_id: yearId.get(c.yearKey), ...c.body, ...(teacher ? { class_teacher_staff_id: teacher } : {}) },
        idempotencyKey: idem(c.key),
      })).body.school_class.id);
  }
  log(`  classes: ${stat("classes").created} new`);

  // ---- 6. learners ----
  await adoptByNaturalKey("learners", plan.learners, tenantId, "/learners", "learners", (l) => l.body.admission_no.toLowerCase(), (e) => String(e.admission_no).trim().toLowerCase());
  for (const l of plan.learners) {
    await ensure("learners", l.key, async () =>
      (await api.request("POST", `${T(tenantId)}/learners`, { tenantId, body: l.body, idempotencyKey: idem(l.key) })).body.learner.id);
  }
  log(`  learners: ${stat("learners").created} new`);

  // ---- 7. class placements ----
  for (const l of plan.learners) {
    if (!l.classKey) continue;
    const learner = ledger.get(l.key);
    const klass = ledger.get(l.classKey);
    if (!learner || !klass) {
      stat("class_placements").parentFailed += 1;
      continue;
    }
    await ensure(
      "class_placements",
      `member:${l.key}`,
      async () =>
        (await api.request("POST", `${T(tenantId)}/class-memberships`, {
          tenantId,
          body: { learner_id: learner, class_id: klass },
          idempotencyKey: idem(`member:${l.key}`),
        })).body.membership.id,
      { conflictIsDone: true },
    );
  }
  log(`  class placements: ${stat("class_placements").created} new`);

  // ---- 8. guardians and their links ----
  await refuseIfUnknownRecordsExist("guardians", plan.guardians, tenantId, "/guardians", "guardians");
  for (const g of plan.guardians) {
    const linkable = g.links.filter((l) => ledger.get(l.learnerKey));
    if (linkable.length === 0) {
      stat("guardians").parentFailed += 1;
      continue;
    }
    const link = (l) => ({ learner_id: ledger.get(l.learnerKey), relationship: l.relationship, is_primary_payer: l.is_primary_payer });
    let guardianId = ledger.get(g.key);
    const guardianExisted = Boolean(guardianId);
    if (guardianExisted) {
      stat("guardians").skipped += 1;
    } else {
      try {
        const res = await api.request("POST", `${T(tenantId)}/guardians`, {
          tenantId,
          body: { ...g.body, learners: [link(linkable[0])] },
          idempotencyKey: idem(g.key),
        });
        guardianId = res.body.guardian.id;
        ledger.set(g.key, guardianId);
        ledger.set(linkable[0].key, res.body.guardian.links?.[0]?.id ?? "created");
        stat("guardians").created += 1;
        stat("guardian_links").created += 1;
      } catch (e) {
        fail("guardians", g.key, e);
        continue;
      }
    }
    for (const l of linkable) {
      if (ledger.has(l.key)) {
        if (guardianExisted) stat("guardian_links").skipped += 1;
        continue;
      }
      await ensure(
        "guardian_links",
        l.key,
        async () =>
          (await api.request("POST", `${T(tenantId)}/guardians/${guardianId}/links`, {
            tenantId,
            body: link(l),
            idempotencyKey: idem(l.key),
          })).body.link?.id ?? "created",
        { conflictIsDone: true },
      );
    }
  }
  log(`  guardians: ${stat("guardians").created} new, links: ${stat("guardian_links").created} new`);

  // ---- 9. archive last ----
  for (const [kind, items, path] of [["archived_learners", plan.learners, "learners"], ["archived_staff", plan.staff, "staff"]]) {
    for (const item of items) {
      if (!item.archive) continue;
      const id = ledger.get(item.key);
      if (!id) {
        stat(kind).parentFailed += 1;
        continue;
      }
      await ensure(kind, `archived:${item.key}`, async () => {
        await api.request("POST", `${T(tenantId)}/${path}/${id}/archive`, { tenantId });
        return "done";
      });
    }
  }

  return result();
}
