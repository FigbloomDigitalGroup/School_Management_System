import { RemovalPolicy, type Stack } from "aws-cdk-lib";
import type * as ec2 from "aws-cdk-lib/aws-ec2";
import type * as ecs from "aws-cdk-lib/aws-ecs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as cr from "aws-cdk-lib/custom-resources";

/**
 * Runs one operator command (the ops task) during a deploy, through CloudFormation.
 *
 * Starting the ops task by hand (infra/scripts/ops.sh) needs iam:PassRole on its two roles, and the account's
 * Deployer role does not have it. CloudFormation does. So a deploy given `-c opsRun=<command>` adds a custom
 * resource that starts the ops task once with that command. The next deploy without `-c opsRun` removes the
 * resource again, and removing it runs nothing.
 *
 *   BOOTSTRAP_ADMIN_EMAIL=you@figbloom.org BOOTSTRAP_ADMIN_NAME="Your Name" FIGBLOOM_BOOTSTRAP_CONFIRM=yes \
 *     CDK_REQUIRE_APPROVAL=never sh infra/scripts/cdk.sh deploy -c opsRun=bootstrap-admin
 *
 * The command's output lands in the ops log group, stream ops/ops/<task id>. CloudFormation does not wait for the
 * task to finish.
 */
export const OPS_COMMANDS = ["bootstrap-admin", "session-hmac", "release"] as const;
/** The only variables passed through, as in ops.sh. Never a secret: task overrides are visible to anyone who can describe the task. */
export const OPS_ENV = ["BOOTSTRAP_ADMIN_EMAIL", "BOOTSTRAP_ADMIN_NAME", "FIGBLOOM_BOOTSTRAP_CONFIRM"] as const;

export interface OpsRun {
  command: string[];
  environment: Record<string, string>;
  /** Changes on every deploy that asks for a run, so CloudFormation runs it again. */
  runId: string;
}

export function opsRunFromContext(value: unknown, env: Record<string, string | undefined>, now = new Date()): OpsRun | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error("-c opsRun takes one command, for example -c opsRun=bootstrap-admin");
  const command = value.trim().split(/\s+/);
  if (!(OPS_COMMANDS as readonly string[]).includes(command[0] ?? "")) {
    throw new Error(`-c opsRun: unknown command "${command[0] ?? ""}" (${OPS_COMMANDS.join(" | ")})`);
  }
  const environment: Record<string, string> = {};
  for (const name of OPS_ENV) {
    const v = env[name];
    if (v) environment[name] = v;
  }
  return { command, environment, runId: now.toISOString() };
}

export interface OpsRunProps {
  run: OpsRun;
  cluster: ecs.ICluster;
  taskDefinition: ecs.FargateTaskDefinition;
  containerName: string;
  subnets: ec2.ISubnet[];
  securityGroupId: string;
}

export function addOpsRun(scope: Stack, props: OpsRunProps): cr.AwsCustomResource {
  const { run, taskDefinition: td, cluster } = props;
  const runTask: cr.AwsSdkCall = {
    service: "ECS",
    action: "RunTask",
    parameters: {
      cluster: cluster.clusterArn,
      taskDefinition: td.taskDefinitionArn,
      launchType: "FARGATE",
      startedBy: "cloudformation-ops-run",
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: props.subnets.map((s) => s.subnetId),
          securityGroups: [props.securityGroupId],
          assignPublicIp: "DISABLED",
        },
      },
      overrides: {
        containerOverrides: [
          {
            name: props.containerName,
            command: run.command,
            environment: Object.entries(run.environment).map(([name, value]) => ({ name, value })),
          },
        ],
      },
    },
    physicalResourceId: cr.PhysicalResourceId.of(`ops-run ${run.runId}`),
    // The full RunTask answer is larger than a custom resource may return.
    outputPaths: ["tasks.0.taskArn"],
  };
  return new cr.AwsCustomResource(scope, "OpsRun", {
    resourceType: "Custom::OpsRun",
    onCreate: runTask,
    onUpdate: runTask,
    installLatestAwsSdk: false,
    logGroup: new logs.LogGroup(scope, "OpsRunLogs", { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: RemovalPolicy.DESTROY }),
    policy: cr.AwsCustomResourcePolicy.fromStatements([
      new iam.PolicyStatement({
        actions: ["ecs:RunTask"],
        resources: [td.taskDefinitionArn],
        conditions: { ArnEquals: { "ecs:cluster": cluster.clusterArn } },
      }),
      new iam.PolicyStatement({
        actions: ["iam:PassRole"],
        resources: [td.obtainExecutionRole().roleArn, td.taskRole.roleArn],
        conditions: { StringEquals: { "iam:PassedToService": "ecs-tasks.amazonaws.com" } },
      }),
    ]),
  });
}
