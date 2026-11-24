#!/usr/bin/env node
// The FigBloom API's production infrastructure (AWS, eu-west-1). Runbook: infra/README.md.
//
//   sh infra/scripts/cdk.sh diff      # always first
//   sh infra/scripts/cdk.sh deploy
import { App, Tags } from "aws-cdk-lib";
import { fileURLToPath } from "node:url";
import { DataStack } from "../lib/data-stack.js";
import { opsRunFromContext } from "../lib/ops-run.js";
import { ServiceStack } from "../lib/service-stack.js";
import { settings } from "../lib/settings.js";

const app = new App();

const account: string | undefined = app.node.tryGetContext("account") ?? process.env.CDK_DEFAULT_ACCOUNT;
if (!account) throw new Error("No AWS account. Run through infra/scripts/cdk.sh (profile figbloom-prod), or pass -c account=<id>.");
const certificateArn: string | undefined = app.node.tryGetContext("certificateArn");
if (!certificateArn) {
  throw new Error(`No certificate. infra/scripts/cdk.sh finds the ISSUED certificate for ${settings.apiDomain}; or pass -c certificateArn=<arn>.`);
}
const env = { account, region: settings.region };

const data = new DataStack(app, settings.stacks.data, {
  env,
  terminationProtection: true,
  description: "Figbloom Schools API (prod): PostgreSQL on RDS, generated secrets, database security groups (stateful; termination protected)",
});
const service = new ServiceStack(app, settings.stacks.service, {
  env,
  data,
  certificateArn,
  repoRoot: fileURLToPath(new URL("../../", import.meta.url)),
  // -c opsRun=<command>: run one operator command during this deploy (lib/ops-run.ts).
  opsRun: opsRunFromContext(app.node.tryGetContext("opsRun"), process.env),
  description: "Figbloom Schools API (prod): image, ECS Fargate API and worker, operator task, host rule on the shared load balancer",
});

// The account's tag convention (every other stack carries these four).
Tags.of(app).add("Project", "figbloom");
Tags.of(app).add("ManagedBy", "cdk");
Tags.of(app).add("Environment", "prod");
Tags.of(data).add("Component", `${settings.component}-data`);
Tags.of(service).add("Component", settings.component);
