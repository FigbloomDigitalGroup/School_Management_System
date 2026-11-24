// The one-off operator run during a deploy (-c opsRun=..., lib/ops-run.ts). Run: npm test (in infra/).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { DataStack } from "../lib/data-stack.js";
import { opsRunFromContext } from "../lib/ops-run.js";
import { ServiceStack } from "../lib/service-stack.js";
import { settings } from "../lib/settings.js";

function synth(opsRun?: ReturnType<typeof opsRunFromContext>) {
  const env = { account: "111111111111", region: settings.region };
  const app = new App({ outdir: mkdtempSync(join(tmpdir(), "figbloom-cdk-")) });
  const data = new DataStack(app, "Data", { env });
  const service = new ServiceStack(app, "Service", {
    env,
    data,
    certificateArn: "arn:aws:acm:eu-west-1:111111111111:certificate/00000000-0000-0000-0000-000000000000",
    repoRoot: fileURLToPath(new URL("../../", import.meta.url)),
    opsRun,
  });
  return Template.fromStack(service);
}

const run = opsRunFromContext(
  "bootstrap-admin",
  { BOOTSTRAP_ADMIN_EMAIL: "a@figbloom.org", BOOTSTRAP_ADMIN_NAME: "A", FIGBLOOM_BOOTSTRAP_CONFIRM: "yes", OWNER_DB_PASSWORD: "x" },
  new Date("2026-11-24T10:00:00Z"),
);
const withRun = synth(run);
const opsRunResource = () => {
  const [r] = Object.values(withRun.findResources("Custom::OpsRun"));
  assert.ok(r, "Custom::OpsRun");
  return JSON.stringify(r.Properties);
};

test("a deploy without -c opsRun runs nothing", () => {
  synth(undefined).resourceCountIs("Custom::OpsRun", 0);
});

test("opsRun takes only the operator commands and passes only the bootstrap variables", () => {
  assert.equal(opsRunFromContext(undefined, {}), undefined);
  assert.equal(opsRunFromContext("", {}), undefined);
  assert.throws(() => opsRunFromContext("sh -c id", {}), /unknown command/);
  assert.throws(() => opsRunFromContext("api", {}), /unknown command/);
  assert.deepEqual(opsRunFromContext("session-hmac status", {})?.command, ["session-hmac", "status"]);
  assert.deepEqual(run?.environment, { BOOTSTRAP_ADMIN_EMAIL: "a@figbloom.org", BOOTSTRAP_ADMIN_NAME: "A", FIGBLOOM_BOOTSTRAP_CONFIRM: "yes" });
});

test("it starts the ops task once, privately, with the command and variables asked for", () => {
  withRun.resourceCountIs("Custom::OpsRun", 1);
  const props = opsRunResource();
  for (const fragment of [
    '\\"action\\":\\"RunTask\\"',
    '\\"launchType\\":\\"FARGATE\\"',
    '\\"assignPublicIp\\":\\"DISABLED\\"',
    '\\"command\\":[\\"bootstrap-admin\\"]',
    '\\"name\\":\\"BOOTSTRAP_ADMIN_EMAIL\\",\\"value\\":\\"a@figbloom.org\\"',
    "ops-run 2026-11-24T10:00:00.000Z",
  ]) {
    assert.ok(props.includes(fragment), `missing ${fragment}`);
  }
  assert.ok(!props.includes("OWNER_DB_PASSWORD"), "no other variable is passed");
});

test("its function may start only the ops task, in our cluster, and pass only the ops task's two roles to ECS", () => {
  const [policy] = Object.values(withRun.findResources("AWS::IAM::Policy", {
    Properties: { PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Action: "iam:PassRole" })]) } },
  }));
  assert.ok(policy, "the custom resource's policy");
  const statements = policy.Properties.PolicyDocument.Statement as { Action: string; Resource: unknown; Condition?: unknown }[];
  assert.deepEqual(statements.map((s) => s.Action).sort(), ["ecs:RunTask", "iam:PassRole"]);
  const runTask = statements.find((s) => s.Action === "ecs:RunTask")!;
  assert.match(JSON.stringify(runTask.Resource), /OpsTask/);
  assert.match(JSON.stringify(runTask.Condition), /ecs:cluster/);
  const passRole = statements.find((s) => s.Action === "iam:PassRole")!;
  const roles = JSON.stringify(passRole.Resource);
  assert.match(roles, /OpsTaskExecutionRole/);
  assert.match(roles, /OpsTaskTaskRole/);
  assert.doesNotMatch(roles, /ApiTask|WorkerTask|\*/);
  assert.deepEqual(passRole.Condition, { StringEquals: { "iam:PassedToService": "ecs-tasks.amazonaws.com" } });
});
