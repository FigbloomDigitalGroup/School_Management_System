# FigBloom API on AWS (production)

The new API (`apps/api`) runs in AWS account profile `figbloom-prod`, region `eu-west-1` (Ireland), at
**https://sms-api.figbloom.org**. Everything is defined in this folder with the AWS CDK. Every setting is in
[`lib/settings.ts`](lib/settings.ts).

| Piece | What it is |
|---|---|
| `FigbloomApiData` stack | Network (two zones, no NAT), PostgreSQL 16 on RDS, the generated secrets. Termination protected; the database has deletion protection and snapshots on removal; secrets are kept even if the stack goes. |
| `FigbloomApiService` stack | The image (built from `infra/api/Dockerfile`), the ECS cluster, the **api** service (2 tasks behind an HTTPS-only load balancer), the **worker** service (1 task), and the **ops** task definition for one-off commands. |
| `api/entrypoint.mjs` | The container's entrypoint: builds each process's database URL from what ECS injects, so a process gets only its own credential. Modes: `api`, `worker`, `release`, `bootstrap-admin`, `session-hmac`. |

Every API and worker task first runs `release` as an init container: migrate, verify, give `figbloom_app` and
`figbloom_worker` their login password, install the session-mint key if the database has none, verify it. The
serving container starts only if that succeeded, and it never receives the database owner's credentials.

Rough cost: about **$120 a month**. That covers the database (t4g.small, ~$29), 3 Fargate tasks (~$45), the
load balancer (~$25), public IPv4 addresses (~$18) and secrets and logs (~$5). `multiAz: true` adds ~$29.

## First deployment

Needs: the AWS CLI, Docker running, Node 24, and someone who can add DNS records for `figbloom.org` (its
nameservers are `ns1.cloudoon.com` etc., not Route 53).

1. **Sign in** (interactive, opens a browser): `aws login --profile figbloom-prod`
2. **Certificate.** Request it, then add the CNAME it asks for at the figbloom.org DNS host:
   ```sh
   aws acm request-certificate --domain-name sms-api.figbloom.org --validation-method DNS --profile figbloom-prod --region eu-west-1
   aws acm describe-certificate --certificate-arn <arn from above> --profile figbloom-prod --region eu-west-1 \
     --query 'Certificate.DomainValidationOptions[0].ResourceRecord'
   ```
   Wait until `aws acm describe-certificate ... --query Certificate.Status` says `ISSUED`, usually minutes
   after the record appears. Keep that CNAME forever: ACM uses it to renew.
3. **Install and bootstrap CDK (once per account and region):**
   ```sh
   cd infra && npm ci
   npx cdk bootstrap aws://<account id>/eu-west-1 --profile figbloom-prod
   ```
4. **Deploy.** Always diff first. The first deploy takes 20-30 minutes, most of it creating the database.
   ```sh
   sh infra/scripts/cdk.sh diff
   sh infra/scripts/cdk.sh deploy
   ```
5. **DNS for the API.** Make `sms-api.figbloom.org` a CNAME to the `LoadBalancerDns` output of `FigbloomApiService`.
6. **Check:** `curl https://sms-api.figbloom.org/readyz` should say `{"status":"ready"}`.
7. **First platform administrator** (once; it refuses if one exists):
   ```sh
   BOOTSTRAP_ADMIN_EMAIL=you@figbloom.org BOOTSTRAP_ADMIN_NAME="Your Name" FIGBLOOM_BOOTSTRAP_CONFIRM=yes \
     sh infra/scripts/ops.sh bootstrap-admin
   ```
   It prints a **single-use setup token valid for 30 minutes**. Use it straight away to choose a password:
   ```sh
   curl -X POST https://sms-api.figbloom.org/v1/auth/password-reset/complete \
     -H 'content-type: application/json' -d '{"token":"<token>","password":"<a long password>"}'
   ```
   Then sign in and enrol two-step (required for platform administrators). The token is also in the
   `/figbloom-api/ops` log group for 7 days; once used it is worthless.

## Releasing a new version

```sh
aws login --profile figbloom-prod
sh infra/scripts/cdk.sh diff
sh infra/scripts/cdk.sh deploy
```

The image is rebuilt from the current checkout. ECS starts new tasks next to the old ones, runs `release`
(migrations) in each, and sends traffic only after `/readyz` is 200. A deployment that cannot become healthy
is rolled back automatically. Migrations are forward-only, so old tasks briefly run against the new schema:
keep migrations backward compatible.

## Operator commands

`sh infra/scripts/ops.sh <mode> [args]` runs one command as the database owner and prints its output:

- `session-hmac status`: keys and replay nonces.
- `session-hmac verify`: does the secret store's key match the database?
- `release`: run the release step by hand.

Rotating the session-mint key is a deliberate procedure: `apps/api/docs/SESSION-HMAC-PROVISIONING.md`.
The key in Secrets Manager (`figbloom-api/session-mint-hmac-key`) must end up matching the database's active key.
`release` never changes the database's key: on a mismatch it stops with exit 2.

## Secrets (Secrets Manager, all generated)

| Name | Used by | Note |
|---|---|---|
| `figbloom-api/db-owner` | `release`, ops task | RDS master user `figbloom_owner`; owns the tables |
| `figbloom-api/app-db-password` | API | `figbloom_app` |
| `figbloom-api/worker-db-password` | worker | `figbloom_worker` |
| `figbloom-api/session-mint-hmac-key` | API, `release` | see rotation above |
| `figbloom-api/idempotency-fingerprint-key` | API | |
| `figbloom-api/mfa-encryption-key` | API | **Encrypts every user's two-step secret. Never change or delete it.** |

After changing a secret's value, force new tasks: `aws ecs update-service --cluster figbloom-api --service api --force-new-deployment`.

## Not set up yet (the API answers "not configured" for these)

- Email and SMS (invitations and password resets).
- M-Pesa or PayHero.
- Push notifications (FCM).
- Document storage (S3).
- Bloom AI.

Each needs its provider account first. Then its variables go into Secrets Manager and the task definition in
`lib/service-stack.ts`. The full list is in `apps/api/env.example`.

Also not set up:

- Alarms.
- A deploy pipeline from GitHub. Deploys run from a signed-in machine.
- ECS Exec.
- A standby database (`multiAz`).

## Recovery

- **Database:** point-in-time restore for the last 14 days (automated backups). There is a final snapshot if the instance is ever deleted.
- **Secrets:** kept on stack deletion. A restored database needs the same `db-owner` password, the same session-mint key and the same MFA encryption key.
- **Logs:**
  - API and worker: `/figbloom-api/api` and `/figbloom-api/worker`, kept 90 days.
  - Release and ops: `/figbloom-api/ops`, kept 7 days.
  - PostgreSQL: `/aws/rds/instance/.../postgresql`, kept 30 days. Bound parameters are never logged.

## Working on this folder

```sh
cd infra
npm ci
npm run typecheck
npm test          # what must stay true of the stacks (no AWS access needed)
npx cdk synth -c account=111111111111 -c certificateArn=arn:aws:acm:eu-west-1:111111111111:certificate/x
```

Rehearse image changes locally before deploying:

```sh
docker build -f infra/api/Dockerfile -t figbloom-api .
```

Then run it against a Postgres 16 that has TLS and a non-superuser owner with CREATEROLE, as RDS does.
