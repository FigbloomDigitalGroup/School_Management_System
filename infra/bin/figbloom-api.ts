#!/usr/bin/env node
// The FigBloom API's production infrastructure (AWS, eu-west-1). Runbook: infra/README.md.
//
//   sh infra/scripts/cdk.sh diff      # always first
//   sh infra/scripts/cdk.sh deploy
import { App, Tags } from "aws-cdk-lib";
import { fileURLToPath } from "node:url";
import { DataStack } from "../lib/data-stack.js";
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

const data = new DataStack(app, "FigbloomApiData", {
  env,
  terminationProtection: true,
  description: "FigBloom API: network, PostgreSQL and generated secrets (stateful; termination protected)",
});
new ServiceStack(app, "FigbloomApiService", {
  env,
  data,
  certificateArn,
  repoRoot: fileURLToPath(new URL("../../", import.meta.url)),
  description: "FigBloom API: image, ECS services (API, worker), operator task, HTTPS load balancer",
});

Tags.of(app).add("project", "figbloom-api");
Tags.of(app).add("environment", "production");
