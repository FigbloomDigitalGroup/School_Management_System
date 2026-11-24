#!/bin/sh
# Runs the CDK CLI on the FigBloom API's production stacks with the right profile, region and certificate.
#
#   sh infra/scripts/cdk.sh diff            # always first: shows what would change
#   sh infra/scripts/cdk.sh deploy          # asks before widening any permission or network access
#   sh infra/scripts/cdk.sh synth
#
# AWS_PROFILE defaults to figbloom-prod. Region and domain match infra/lib/settings.ts.
# Without a terminal (CI, an agent) the approval question cannot be answered: after reading the diff, run
# CDK_REQUIRE_APPROVAL=never sh infra/scripts/cdk.sh deploy. (The CLI refuses --require-approval twice.)
set -eu
export MSYS_NO_PATHCONV=1 # Git Bash on Windows: do not rewrite /paths in arguments

cd "$(dirname "$0")/.."
PROFILE="${AWS_PROFILE:-figbloom-prod}"
REGION=eu-west-1
DOMAIN=sms-api.figbloom.org

cmd="${1:-}"
[ -n "$cmd" ] || { echo "usage: sh infra/scripts/cdk.sh diff|deploy|synth [cdk options]" >&2; exit 64; }
shift

CERT=$(aws acm list-certificates --profile "$PROFILE" --region "$REGION" --certificate-statuses ISSUED \
  --query "CertificateSummaryList[?DomainName=='$DOMAIN'].CertificateArn | [0]" --output text)
if [ -z "$CERT" ] || [ "$CERT" = "None" ]; then
  echo "No ISSUED certificate for $DOMAIN in $REGION (infra/README.md, step 2)." >&2
  exit 1
fi

case "$cmd" in
  deploy) exec npx cdk deploy --all --profile "$PROFILE" -c certificateArn="$CERT" --require-approval "${CDK_REQUIRE_APPROVAL:-broadening}" "$@" ;;
  *) exec npx cdk "$cmd" --all --profile "$PROFILE" -c certificateArn="$CERT" "$@" ;;
esac
