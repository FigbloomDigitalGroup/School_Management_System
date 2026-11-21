#!/usr/bin/env node
/**
 * Source-edit negative controls for Stage C (NC-1 call-site setter, NC-2 route
 * conversion, NC-3 ordering). Applies a mutation, runs one vitest filter,
 * restores the file, then exits non-zero if the mutated run did not fail.
 *
 * Usage (from apps/api):
 *   node test/negative-controls/source-mutations.mjs nc1|nc2|nc3|all
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

function runVitest(filter) {
  // Quote the filter so Windows shells do not split on spaces.
  const cmd = `npx vitest run -t ${JSON.stringify(filter)}`;
  return spawnSync(cmd, {
    cwd: root,
    encoding: "utf8",
    shell: true,
  });
}

function withMutation(fileRel, mutate, filter) {
  const file = join(root, fileRel);
  const original = readFileSync(file, "utf8");
  const mutated = mutate(original);
  if (mutated === original) {
    throw new Error(`Mutation produced no change for ${fileRel}`);
  }
  writeFileSync(file, mutated, "utf8");
  let result;
  try {
    result = runVitest(filter);
  } finally {
    writeFileSync(file, original, "utf8");
  }
  const failed = result.status !== 0;
  return {
    file: fileRel,
    filter,
    exitCode: result.status,
    failedAsExpected: failed,
    stderrTail: (result.stderr || result.stdout || "").slice(-800),
  };
}

const controls = {
  nc1: () =>
    withMutation(
      "src/db/tenantTransaction.ts",
      (src) =>
        src.replace(
          /await setTenantContext\(client, \{\s*userId: input\.userId,\s*tenantId: input\.requestedTenantId,\s*\}\);/m,
          `// NC-1 mutation: tenant context setter removed
    await setUserContextOnly(client, input.userId);`,
        ),
      "transaction-local across alternating",
    ),
  nc2: () =>
    withMutation(
      "src/http/routes/learners.ts",
      (src) => src.replace(/withTenantRequest/g, "withIdentityAccess"),
      "requires withTenantRequest on every tenant business route",
    ),
  nc3: () =>
    withMutation(
      "src/db/tenantTransaction.ts",
      (src) =>
        src.replace(
          /await setUserContextOnly\(client, input\.userId\);\s*\n\s*try \{\s*\n\s*await input\.authorize\(createIdentityHandle\(client\)\);\s*\n\s*\} catch \(err\) \{\s*\n\s*await guardedRollback\(client, err\);\s*\n\s*\}\s*\n\s*await setTenantContext\(client, \{\s*userId: input\.userId,\s*tenantId: input\.requestedTenantId,\s*\}\);/m,
          `await setTenantContext(client, {
      userId: input.userId,
      tenantId: input.requestedTenantId,
    });

    try {
      await input.authorize(createIdentityHandle(client));
    } catch (err) {
      await guardedRollback(client, err);
    }`,
        ),
      "does not set the tenant when authorisation fails",
    ),
};

const arg = process.argv[2] ?? "all";
const names = arg === "all" ? Object.keys(controls) : [arg];
const report = [];
for (const name of names) {
  if (!controls[name]) {
    console.error(`Unknown control ${name}`);
    process.exit(2);
  }
  console.error(`Running ${name}...`);
  const outcome = controls[name]();
  report.push({ name, ...outcome });
  console.error(JSON.stringify({ name, ...outcome }, null, 2));
}

const ok = report.every((r) => r.failedAsExpected);
const reportPath = join(root, "../../.personal-ai/execution/WP-A1-STAGE-C-NC-SOURCE-MUTATIONS.json");
writeFileSync(reportPath, JSON.stringify({ ok, report, at: new Date().toISOString() }, null, 2), "utf8");
console.error(`Wrote ${reportPath}`);
process.exit(ok ? 0 : 1);
