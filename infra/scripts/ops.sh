#!/bin/sh
# Runs one operator command in the production "ops" task (as the database owner) and prints its output.
#
#   sh infra/scripts/ops.sh session-hmac status
#   sh infra/scripts/ops.sh release
#   BOOTSTRAP_ADMIN_EMAIL=you@example.org BOOTSTRAP_ADMIN_NAME="Your Name" FIGBLOOM_BOOTSTRAP_CONFIRM=yes \
#     sh infra/scripts/ops.sh bootstrap-admin
#
# Commands: infra/api/entrypoint.mjs. Output also stays in the /figbloom/schools-api/ops log group (kept 7 days).
# Only the three bootstrap variables above are passed through; never pass a secret here (task overrides
# are visible to anyone who can describe the task).
set -eu
export MSYS_NO_PATHCONV=1 # Git Bash on Windows: do not rewrite /figbloom/... into a Windows path

[ $# -gt 0 ] || { echo "usage: sh infra/scripts/ops.sh <command> [args]" >&2; exit 64; }
PROFILE="${AWS_PROFILE:-figbloom-prod}"
REGION=eu-west-1
aws_() { aws --profile "$PROFILE" --region "$REGION" "$@"; }
output() {
  aws_ cloudformation describe-stacks --stack-name SchoolsApi-prod \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}

CLUSTER=$(output ClusterName)
TASK_DEF=$(output OpsTaskDefinition)
SUBNETS=$(output OpsSubnets)
SG=$(output OpsSecurityGroup)
LOG_GROUP=$(output OpsLogGroup)

OVERRIDES=$(node -e '
  const env = ["BOOTSTRAP_ADMIN_EMAIL", "BOOTSTRAP_ADMIN_NAME", "FIGBLOOM_BOOTSTRAP_CONFIRM"]
    .filter((n) => process.env[n])
    .map((name) => ({ name, value: process.env[name] }));
  console.log(JSON.stringify({ containerOverrides: [{ name: "ops", command: process.argv.slice(1), environment: env }] }));
' "$@")

TASK=$(aws_ ecs run-task --cluster "$CLUSTER" --task-definition "$TASK_DEF" --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$SG],assignPublicIp=DISABLED}" \
  --overrides "$OVERRIDES" --query 'tasks[0].taskArn' --output text)
echo "started ${TASK##*/}; waiting for it to finish..." >&2
aws_ ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK"

aws_ logs get-log-events --log-group-name "$LOG_GROUP" --log-stream-name "ops/ops/${TASK##*/}" \
  --start-from-head --query 'events[].message' --output text | tr '\t' '\n'
EXIT=$(aws_ ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK" \
  --query "tasks[0].containers[?name=='ops'].exitCode | [0]" --output text)
echo "exit $EXIT" >&2
[ "$EXIT" = "0" ]
