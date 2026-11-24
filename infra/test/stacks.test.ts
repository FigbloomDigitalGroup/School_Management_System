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
const both = [dataT, serviceT];

type ContainerDef = { Name: string; Secrets?: { Name: string }[]; Environment?: { Name: string; Value: unknown }[]; DependsOn?: unknown[]; Essential?: boolean; Command?: string[] };
function containers(family: string): ContainerDef[] {
  const defs = serviceT.findResources("AWS::ECS::TaskDefinition", { Properties: { Family: family } });
  const [def] = Object.values(defs);
  assert.ok(def, `task definition ${family}`);
  return def.Properties.ContainerDefinitions as ContainerDef[];
}
const API = `figbloom-${settings.component}`;
const WORKER = `figbloom-${settings.component}-worker`;
const secretNames = (c: ContainerDef) => (c.Secrets ?? []).map((s) => s.Name).sort();
const envValue = (c: ContainerDef, name: string) => c.Environment?.find((e) => e.Name === name)?.Value;
const imports = (t: Template) => [...new Set(JSON.stringify(t.toJSON()).match(/"Fn::ImportValue":"[^"]+"/g) ?? [])].map((s) => s.slice('"Fn::ImportValue":"'.length, -1));

test("the API process never receives the owner's or the worker's credentials", () => {
  const api = containers(API).find((c) => c.Name === "api")!;
  assert.deepEqual(secretNames(api), ["APP_DB_PASSWORD", "IDEMPOTENCY_FINGERPRINT_KEY", "MFA_ENCRYPTION_KEY", "SESSION_MINT_HMAC_KEY"]);
  assert.equal(envValue(api, "MIGRATION_DATABASE_URL"), undefined);
});

test("the worker process holds only its own password", () => {
  const worker = containers(WORKER).find((c) => c.Name === "worker")!;
  assert.deepEqual(secretNames(worker), ["WORKER_DB_PASSWORD"]);
});

test("API and worker start only after the release step succeeded", () => {
  for (const [family, name] of [[API, "api"], [WORKER, "worker"]] as const) {
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
  const api = containers(API).find((c) => c.Name === "api")!;
  assert.equal(envValue(api, "APP_ENV"), "production");
  assert.equal(envValue(api, "MFA_ENFORCEMENT"), "enforce");
  assert.equal(envValue(api, "CORS_ALLOWED_ORIGINS"), "https://schoolmanagement.figbloom.org");
  assert.equal(envValue(api, "API_TRUST_PROXY_HOPS"), "1");
  assert.equal(envValue(api, "API_TRUST_PROXY_CIDRS"), settings.platform.vpcCidr);
  assert.equal(envValue(api, "HSTS_ENABLED"), "true");
});

test("the API keeps idle connections longer than the shared load balancer (no 502 on reuse)", () => {
  const api = containers(API).find((c) => c.Name === "api")!;
  const keepAlive = Number(envValue(api, "SERVER_KEEP_ALIVE_TIMEOUT_MS"));
  assert.ok(keepAlive > settings.platform.loadBalancerIdleTimeoutSeconds * 1000, String(keepAlive));
  assert.ok(Number(envValue(api, "SERVER_HEADERS_TIMEOUT_MS")) > keepAlive);
});

test("it builds no network and no load balancer of its own: it uses the shared ones", () => {
  for (const t of both) {
    for (const type of ["AWS::EC2::VPC", "AWS::EC2::Subnet", "AWS::EC2::NatGateway", "AWS::ElasticLoadBalancingV2::LoadBalancer", "AWS::ElasticLoadBalancingV2::Listener"]) {
      t.resourceCountIs(type, 0);
    }
  }
  const used = new Set([...imports(dataT), ...imports(serviceT)]);
  // Only the shared platform's exports and this app's own data stack.
  for (const name of used) assert.match(name, new RegExp(`^(Network-prod|Edge-prod|${data.stackName}):`), name);
  assert.deepEqual(imports(dataT).filter((n) => !n.startsWith("Network-prod:")), [], "the data stack depends on the network only");
  assert.ok([...used].some((n) => n.startsWith("Edge-prod:ExportsOutputRefLbHttps")));
});

test("the shared listener gets our certificate and one host rule for our domain only", () => {
  serviceT.resourceCountIs("AWS::ElasticLoadBalancingV2::ListenerCertificate", 1);
  serviceT.resourceCountIs("AWS::ElasticLoadBalancingV2::ListenerRule", 1);
  serviceT.hasResourceProperties("AWS::ElasticLoadBalancingV2::ListenerRule", {
    Priority: settings.platform.listenerRulePriority,
    Conditions: [{ Field: "host-header", HostHeaderConfig: { Values: [settings.apiDomain] } }],
  });
  serviceT.hasResourceProperties("AWS::ElasticLoadBalancingV2::TargetGroup", { HealthCheckPath: "/readyz", Port: settings.api.port, TargetType: "ip" });
  serviceT.hasResource("AWS::ECS::Service", { DependsOn: Match.arrayWith([Match.stringLikeRegexp("HostRule")]) });
});

test("tasks run in the private subnets without public addresses", () => {
  const services = Object.values(serviceT.findResources("AWS::ECS::Service"));
  assert.equal(services.length, 2);
  for (const s of services) {
    assert.equal(s.Properties.NetworkConfiguration.AwsvpcConfiguration.AssignPublicIp, "DISABLED");
    assert.match(JSON.stringify(s.Properties.NetworkConfiguration.AwsvpcConfiguration.Subnets), /privateSubnet/);
  }
});

test("the API port is open to the shared load balancer only", () => {
  const rules = Object.values(serviceT.findResources("AWS::EC2::SecurityGroupIngress")).map((r) => r.Properties);
  const toApi = rules.filter((p) => p.FromPort === settings.api.port);
  assert.equal(toApi.length, 1);
  assert.deepEqual(toApi[0].SourceSecurityGroupId, { "Fn::ImportValue": "Edge-prod:ExportsOutputFnGetAttLbSecurityGroup89A8258DGroupId639A5917" });
  assert.equal(toApi[0].CidrIp, undefined);
  const taskSgs = dataT.findResources("AWS::EC2::SecurityGroup", { Properties: { GroupDescription: Match.stringLikeRegexp("^Schools API (tasks|worker tasks|one-off operator tasks) ") } });
  assert.equal(Object.keys(taskSgs).length, 3);
  for (const sg of Object.values(taskSgs)) assert.equal(sg.Properties.SecurityGroupIngress, undefined, sg.Properties.GroupDescription);
});

test("PostgreSQL 16 is private, encrypted, backed up, protected from deletion and forces TLS", () => {
  dataT.hasResourceProperties("AWS::RDS::DBInstance", {
    Engine: "postgres",
    EngineVersion: Match.stringLikeRegexp("^16"),
    DBInstanceIdentifier: settings.database.instanceIdentifier,
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
  dataT.hasResourceProperties("AWS::RDS::DBSubnetGroup", { SubnetIds: Match.arrayWith([{ "Fn::ImportValue": Match.stringLikeRegexp("privateSubnet1") }]) });
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
  const all = both.flatMap((t) => Object.values(t.findResources("AWS::EC2::SecurityGroupIngress")).map((r) => r.Properties));
  assert.equal(all.filter((p) => p.FromPort === 5432).length, 3);
});

test("every generated secret and the owner's credentials survive a stack deletion, under figbloom/schools-api/", () => {
  const secrets = dataT.findResources("AWS::SecretsManager::Secret");
  assert.equal(Object.keys(secrets).length, 6);
  for (const [id, s] of Object.entries(secrets)) {
    assert.equal(s.DeletionPolicy, "Retain", id);
    assert.match(s.Properties.Name, /^figbloom\/schools-api\//, id);
  }
});

test("the data stack is termination protected", () => {
  assert.equal(data.terminationProtection, true);
});
