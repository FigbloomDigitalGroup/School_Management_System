// What must stay true of the production stacks. Run: npm test (in infra/).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { DataStack } from "../lib/data-stack.js";
import { ServiceStack } from "../lib/service-stack.js";
import { settings } from "../lib/settings.js";

const env = { account: "111111111111", region: settings.region };
const app = new App({ outdir: mkdtempSync(join(tmpdir(), "figbloom-cdk-")) });
const data = new DataStack(app, "Data", { env, terminationProtection: true });
const service = new ServiceStack(app, "Service", {
  env,
  data,
  certificateArn: "arn:aws:acm:eu-west-1:111111111111:certificate/00000000-0000-0000-0000-000000000000",
  repoRoot: fileURLToPath(new URL("../../", import.meta.url)),
});
const dataT = Template.fromStack(data);
const serviceT = Template.fromStack(service);

type ContainerDef = { Name: string; Secrets?: { Name: string }[]; Environment?: { Name: string; Value: unknown }[]; DependsOn?: unknown[]; Essential?: boolean; Command?: string[] };
function containers(family: string): ContainerDef[] {
  const defs = serviceT.findResources("AWS::ECS::TaskDefinition", { Properties: { Family: family } });
  const [def] = Object.values(defs);
  assert.ok(def, `task definition ${family}`);
  return def.Properties.ContainerDefinitions as ContainerDef[];
}
const secretNames = (c: ContainerDef) => (c.Secrets ?? []).map((s) => s.Name).sort();
const envValue = (c: ContainerDef, name: string) => c.Environment?.find((e) => e.Name === name)?.Value;

test("the API process never receives the owner's or the worker's credentials", () => {
  const api = containers("figbloom-api").find((c) => c.Name === "api")!;
  assert.deepEqual(secretNames(api), ["APP_DB_PASSWORD", "IDEMPOTENCY_FINGERPRINT_KEY", "MFA_ENCRYPTION_KEY", "SESSION_MINT_HMAC_KEY"]);
  assert.equal(envValue(api, "MIGRATION_DATABASE_URL"), undefined);
});

test("the worker process holds only its own password", () => {
  const worker = containers("figbloom-worker").find((c) => c.Name === "worker")!;
  assert.deepEqual(secretNames(worker), ["WORKER_DB_PASSWORD"]);
});

test("API and worker start only after the release step succeeded", () => {
  for (const [family, name] of [["figbloom-api", "api"], ["figbloom-worker", "worker"]] as const) {
    const defs = containers(family);
    const release = defs.find((c) => c.Name === "release")!;
    assert.deepEqual(release.Command, ["release"]);
    assert.equal(release.Essential, false);
    assert.ok(secretNames(release).includes("OWNER_DB_PASSWORD"));
    const main = defs.find((c) => c.Name === name)!;
    assert.deepEqual(main.DependsOn, [{ ContainerName: "release", Condition: "SUCCESS" }]);
  }
});

test("API runs in production mode with enforced two-step, exact CORS origin and one trusted proxy hop", () => {
  const api = containers("figbloom-api").find((c) => c.Name === "api")!;
  assert.equal(envValue(api, "APP_ENV"), "production");
  assert.equal(envValue(api, "MFA_ENFORCEMENT"), "enforce");
  assert.equal(envValue(api, "CORS_ALLOWED_ORIGINS"), "https://schoolmanagement.figbloom.org");
  assert.equal(envValue(api, "API_TRUST_PROXY_HOPS"), "1");
  assert.equal(envValue(api, "API_TRUST_PROXY_CIDRS"), settings.vpcCidr);
  assert.equal(envValue(api, "HSTS_ENABLED"), "true");
});

test("the load balancer listens on HTTPS 443 only and checks /readyz", () => {
  serviceT.resourceCountIs("AWS::ElasticLoadBalancingV2::Listener", 1);
  serviceT.hasResourceProperties("AWS::ElasticLoadBalancingV2::Listener", { Port: 443, Protocol: "HTTPS" });
  serviceT.hasResourceProperties("AWS::ElasticLoadBalancingV2::TargetGroup", { HealthCheckPath: "/readyz", Port: settings.api.port });
  const albSgs = serviceT.findResources("AWS::EC2::SecurityGroup", { Properties: { GroupDescription: Match.stringLikeRegexp("load balancer") } });
  const ingress = Object.values(albSgs).flatMap((r) => r.Properties.SecurityGroupIngress ?? []);
  assert.deepEqual(ingress.map((i: { FromPort: number }) => i.FromPort), [443]);
});

test("the API port is open to the load balancer only", () => {
  const rules = serviceT.findResources("AWS::EC2::SecurityGroupIngress");
  const toApi = Object.values(rules).filter((r) => r.Properties.FromPort === settings.api.port);
  assert.equal(toApi.length, 1);
  assert.ok(toApi[0].Properties.SourceSecurityGroupId, "from a security group (the load balancer's)");
  assert.equal(toApi[0].Properties.CidrIp, undefined);
  for (const t of [dataT, serviceT]) {
    const sgs = t.findResources("AWS::EC2::SecurityGroup", { Properties: { GroupDescription: Match.stringLikeRegexp("API tasks|worker tasks|operator tasks") } });
    for (const sg of Object.values(sgs)) assert.equal(sg.Properties.SecurityGroupIngress, undefined, sg.Properties.GroupDescription);
  }
});

test("PostgreSQL 16 is private, encrypted, backed up, protected from deletion and forces TLS", () => {
  dataT.hasResourceProperties("AWS::RDS::DBInstance", {
    Engine: "postgres",
    EngineVersion: Match.stringLikeRegexp("^16"),
    PubliclyAccessible: false,
    StorageEncrypted: true,
    DeletionProtection: true,
    BackupRetentionPeriod: settings.database.backupRetentionDays,
    DBName: settings.database.name,
  });
  dataT.hasResource("AWS::RDS::DBInstance", { DeletionPolicy: "Snapshot", UpdateReplacePolicy: "Snapshot" });
  dataT.hasResourceProperties("AWS::RDS::DBParameterGroup", {
    Parameters: Match.objectLike({ "rds.force_ssl": "1", log_parameter_max_length: "0" }),
  });
});

test("the database admits only the API, worker and operator tasks", () => {
  const dbSgs = dataT.findResources("AWS::EC2::SecurityGroup", { Properties: { GroupDescription: Match.stringLikeRegexp("PostgreSQL") } });
  const [dbSgId] = Object.keys(dbSgs);
  assert.ok(dbSgId);
  assert.equal(dbSgs[dbSgId].Properties.SecurityGroupIngress, undefined, "no inline rules");
  const rules = Object.values(dataT.findResources("AWS::EC2::SecurityGroupIngress"))
    .map((r) => r.Properties)
    .filter((p) => JSON.stringify(p.GroupId).includes(dbSgId));
  assert.equal(rules.length, 3);
  for (const r of rules) {
    assert.equal(r.FromPort, 5432);
    assert.ok(r.SourceSecurityGroupId && !r.CidrIp, "a security group, never an address range");
  }
  // Nothing else in either stack opens the database port.
  const all = [dataT, serviceT].flatMap((t) => Object.values(t.findResources("AWS::EC2::SecurityGroupIngress")).map((r) => r.Properties));
  assert.equal(all.filter((p) => p.FromPort === 5432).length, 3);
});

test("every generated secret and the owner's credentials survive a stack deletion", () => {
  const secrets = dataT.findResources("AWS::SecretsManager::Secret");
  assert.equal(Object.keys(secrets).length, 6);
  for (const [id, s] of Object.entries(secrets)) assert.equal(s.DeletionPolicy, "Retain", id);
});

test("the data stack is termination protected", () => {
  assert.equal(data.terminationProtection, true);
});
