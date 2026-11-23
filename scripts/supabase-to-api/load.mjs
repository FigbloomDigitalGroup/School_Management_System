#!/usr/bin/env node
// Step 2 of the Supabase -> apps/api move: plan the copy, and (with --apply) carry it out over the API's HTTP
// endpoints. Never SQL: the API's tenant, permission and audit checks apply to every record.
//
//   node scripts/supabase-to-api/load.mjs --snapshot <dir> --state <dir> [--overrides file.json] [--school slug]...
//        [--apply] [--adopt slug=<tenant uuid>]... [--allow-remote]
//
// Without --apply it only plans: no request is sent, and it writes <state>/plan-report.json listing what would be
// created and every record that would be refused, with the reason. With --apply, set API_BASE_URL, API_EMAIL and
// API_PASSWORD (a platform super administrator), and API_TOTP_SECRET if the API enforces two-step sign-in.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApi } from "./lib/api.mjs";
import { openLedger } from "./lib/ledger.mjs";
import { buildPlan, summarisePlan } from "./lib/mapping.mjs";
import { applySchool, describe } from "./lib/run.mjs";
import { assertOutsideRepo, isLoopbackUrl } from "./lib/safety.mjs";

function parseArgs(argv) {
  const out = { schools: [], adopt: {}, apply: false, allowRemote: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--snapshot") out.snapshot = argv[(i += 1)];
    else if (a === "--state") out.state = argv[(i += 1)];
    else if (a === "--overrides") out.overrides = argv[(i += 1)];
    else if (a === "--school") out.schools.push(argv[(i += 1)]);
    else if (a === "--adopt") {
      const [slug, id] = String(argv[(i += 1)]).split("=");
      if (!slug || !/^[0-9a-f-]{36}$/.test(id ?? "")) throw new Error("--adopt takes slug=<lowercase tenant uuid>");
      out.adopt[slug] = id;
    } else if (a === "--apply") out.apply = true;
    else if (a === "--allow-remote") out.allowRemote = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return out;
}

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.snapshot) throw new Error("Pass --snapshot <the folder extract.mjs wrote>.");
  if (!args.state) throw new Error("Pass --state <a folder for this target's ledger and reports>, outside the repository.");
  const stateDir = assertOutsideRepo(args.state, "--state");
  mkdirSync(stateDir, { recursive: true });

  const snapshot = {};
  for (const name of ["organizations", "tenants", "terms", "classes", "profiles", "students", "guardians"]) {
    snapshot[name] = readJson(join(args.snapshot, `${name}.json`));
  }
  const overrides = args.overrides ? readJson(args.overrides) : {};
  const plan = buildPlan(snapshot, { overrides, only: args.schools });

  const summary = summarisePlan(plan);
  for (const s of summary) {
    console.log(`\n${s.slug}`);
    console.log("  would create:", JSON.stringify(s.toCreate));
    if (Object.keys(s.blocked).length) {
      console.log("  BLOCKED (will not be copied):", JSON.stringify(s.blocked));
      for (const [reason, n] of Object.entries(s.blockedReasons)) console.log(`    ${n} x ${reason}`);
    }
    if (Object.keys(s.warnings).length) console.log("  warnings (copied, with something left out):", JSON.stringify(s.warnings));
    console.log("  not carried, nowhere to go in the API:", JSON.stringify(s.notCarried));
  }
  writeFileSync(
    join(stateDir, "plan-report.json"),
    JSON.stringify(
      { plannedAt: new Date().toISOString(), summary, details: plan.schools.map((s) => ({ slug: s.school.slug, blocked: s.blocked, warnings: s.warnings })) },
      null,
      2,
    ),
  );
  console.log(`\nplan report: ${join(stateDir, "plan-report.json")}`);

  if (!args.apply) {
    console.log("Dry run only: nothing was sent. Add --apply to carry it out.");
    return;
  }

  const baseUrl = process.env.API_BASE_URL;
  const email = process.env.API_EMAIL;
  const password = process.env.API_PASSWORD;
  if (!baseUrl || !email || !password) throw new Error("--apply needs API_BASE_URL, API_EMAIL and API_PASSWORD in the environment.");
  if (!isLoopbackUrl(baseUrl) && !args.allowRemote) {
    throw new Error(`${new URL(baseUrl).host} is not this machine. Add --allow-remote to write into a remote API.`);
  }

  // A ledger belongs to one API: refuse to use it against another.
  const targetFile = join(stateDir, "target.json");
  const target = new URL(baseUrl).origin;
  if (existsSync(targetFile) && readJson(targetFile).origin !== target) {
    throw new Error(`This state folder was used for ${readJson(targetFile).origin}. Use a new --state folder for ${target}.`);
  }
  writeFileSync(targetFile, JSON.stringify({ origin: target }));

  const api = createApi({ baseUrl });
  await api.signIn({ email, password, totpSecret: process.env.API_TOTP_SECRET || undefined });
  const ledger = openLedger(join(stateDir, "ledger.jsonl"));
  const secretsFile = join(stateDir, "invitations.jsonl");

  const results = [];
  for (const schoolPlan of plan.schools) {
    console.log(`\napplying ${schoolPlan.school.slug} to ${target}`);
    try {
      results.push(await applySchool({ api, ledger, adopt: args.adopt, secretsFile, log: console.log }, schoolPlan));
    } catch (e) {
      results.push({ school: schoolPlan.school.slug, stopped: describe(e).message, stats: {}, failures: [] });
      console.error(`  stopped: ${describe(e).message}`);
    }
  }

  writeFileSync(join(stateDir, "run-report.json"), JSON.stringify({ ranAt: new Date().toISOString(), target, results }, null, 2));
  let bad = 0;
  for (const r of results) {
    console.log(`\n${r.school}${r.stopped ? `  STOPPED: ${r.stopped}` : ""}`);
    for (const [kind, s] of Object.entries(r.stats)) {
      console.log(`  ${kind.padEnd(18)} created ${s.created}  adopted ${s.adopted}  already ${s.skipped}  failed ${s.failed}  parent-missing ${s.parentFailed}`);
      bad += s.failed;
    }
    for (const f of r.failures.slice(0, 10)) console.log(`  FAILED ${f.kind} ${f.key}: ${f.status ?? ""} ${f.code ?? ""}`);
    if (r.failures.length > 10) console.log(`  ... and ${r.failures.length - 10} more in run-report.json`);
    if (r.stopped) bad += 1;
  }
  console.log(`\nrun report: ${join(stateDir, "run-report.json")}`);
  if (existsSync(secretsFile)) console.log(`invitation tokens for the first school administrators: ${secretsFile} (secret; deliver, then delete)`);
  if (bad > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e.message);
  // Not process.exit(): on Windows it can trip a libuv assertion while sockets are still closing.
  process.exitCode = 1;
});
