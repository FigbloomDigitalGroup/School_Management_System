# Schools API on AWS (production)

The new API (`apps/api`) runs in AWS account profile `figbloom-prod`, region `eu-west-1` (Ireland), at
**https://sms-api.figbloom.org**. Everything is defined in this folder with the AWS CDK. Every setting is in
[`lib/settings.ts`](lib/settings.ts).

It plugs into the account's **shared platform**, as the HR, CRM, Fleet and Platform apps do. It only reads the
platform's exports ([`lib/platform.ts`](lib/platform.ts)):

- `Network-prod`: one VPC. The tasks and the database sit in its private subnets and reach the internet (M-Pesa, push, ...) through its NAT gateway.
- `Edge-prod`: one internet-facing load balancer. This app adds its certificate to the HTTPS listener plus one rule: host `sms-api.figbloom.org` goes to the API. Port 80 already redirects to HTTPS for every host.

| Stack | What it is |
|---|---|
| `SchoolsApiData-prod` | PostgreSQL 16 on RDS, the generated secrets, and the security groups that decide who may reach the database. Termination protected. The database has deletion protection and takes a snapshot on removal. Secrets are kept even if the stack goes. |
| `SchoolsApi-prod` | The image (built from `infra/api/Dockerfile`), the ECS cluster, the **api** service (2 tasks), the **worker** service (1 task), the **ops** task definition for one-off commands (plus, only in a deploy given `-c opsRun`, the custom resource that starts it), and the host rule on the shared load balancer. |

`api/entrypoint.mjs` is the container's entrypoint. It builds each process's database URL from what ECS
injects, so a process gets only its own credential. Modes: `api`, `worker`, `release`, `bootstrap-admin`,
`session-hmac`.

Every API and worker task first runs `release` as an init container:

1. Migrate, then verify.
2. Give `figbloom_app` and `figbloom_worker` their login password.
3. Install the session-mint key if the database has none, then verify it.

The serving container starts only if that succeeded, and it never receives the database owner's credentials.

Rough cost: about **$80 a month**. That covers the database (t4g.small, ~$29), 3 Fargate tasks (~$45), and
secrets and logs (~$5). The load balancer and NAT are shared. `multiAz: true` adds ~$29.

## First deployment

Needs:

- The AWS CLI, Docker running and Node 24.
- Someone who can add DNS records for `figbloom.org`. Its nameservers are `ns1.cloudoon.com` etc., not Route 53.

1. **Sign in** (interactive, opens a browser): `aws login --profile figbloom-prod`
2. **Certificate** (already requested on 2026-11-24). Add its validation CNAME at the figbloom.org DNS host:
   ```sh
   aws acm list-certificates --profile figbloom-prod --region eu-west-1 --query "CertificateSummaryList[?DomainName=='sms-api.figbloom.org']"
   aws acm describe-certificate --certificate-arn <arn> --profile figbloom-prod --region eu-west-1 \
     --query 'Certificate.[Status, DomainValidationOptions[0].ResourceRecord]'
   ```
   Wait for `ISSUED`, usually minutes after the record appears. Keep that CNAME forever: ACM uses it to renew.
3. **Install.** The account is already CDK-bootstrapped (`cdk bootstrap` is not needed again):
   ```sh
   cd infra && npm ci
   ```
4. **Deploy.** Always diff first. The first deploy takes 20-30 minutes, most of it creating the database.
   ```sh
   sh infra/scripts/cdk.sh diff
   sh infra/scripts/cdk.sh deploy
   ```
5. **DNS for the API.** Make `sms-api.figbloom.org` a CNAME to the shared load balancer, which is the `LoadBalancerDns` output of `Edge-prod`.
6. **Check:** `curl https://sms-api.figbloom.org/readyz` should say `{"status":"ready"}`.
7. **First platform administrator** (once; it refuses if one exists). With the Deployer role, run it through a deploy
   (see [Operator commands](#operator-commands)):
   ```sh
   BOOTSTRAP_ADMIN_EMAIL=you@figbloom.org BOOTSTRAP_ADMIN_NAME="Your Name" FIGBLOOM_BOOTSTRAP_CONFIRM=yes \
     CDK_REQUIRE_APPROVAL=never sh infra/scripts/cdk.sh deploy -c opsRun=bootstrap-admin
   ```
   It writes a **single-use setup token valid for 30 minutes** to the newest `ops/ops/...` stream of the
   `/figbloom/schools-api/ops` log group. Use it straight away to choose a password:
   ```sh
   curl -X POST https://sms-api.figbloom.org/v1/auth/password-reset/complete \
     -H 'content-type: application/json' -d '{"token":"<token>","password":"<a long password>"}'
   ```
   Then sign in and enrol two-step (required for platform administrators). The token is also in the
   `/figbloom/schools-api/ops` log group for 7 days; once used it is worthless.

## Releasing a new version

```sh
aws login --profile figbloom-prod
sh infra/scripts/cdk.sh diff
sh infra/scripts/cdk.sh deploy
```

The image is rebuilt from the current checkout. Then:

- ECS starts new tasks next to the old ones and runs `release` (migrations) in each.
- Traffic moves to a new task only after its `/readyz` returns 200.
- A deployment that cannot become healthy is rolled back automatically.

Migrations are forward-only, so old tasks briefly run against the new schema: keep migrations backward compatible.

## Operator commands

An operator command runs once in the **ops task**, as the database owner:

- `bootstrap-admin`: the first platform administrator (above).
- `session-hmac status`: keys and replay nonces.
- `session-hmac verify`: does the secret store's key match the database?
- `release`: run the release step by hand.

There are two ways to start one:

- **Through a deploy** (works with the Deployer role). The deploy adds a custom resource that starts the ops task
  once; the next deploy without `-c opsRun` removes it again, and removing it runs nothing. Read the output in the
  newest `ops/ops/...` stream of `/figbloom/schools-api/ops`.
  ```sh
  CDK_REQUIRE_APPROVAL=never sh infra/scripts/cdk.sh deploy -c opsRun="session-hmac status"
  sh infra/scripts/cdk.sh deploy   # afterwards: removes the one-off resource
  ```
- **By hand:** `sh infra/scripts/ops.sh <command> [args]` prints the output itself, but starting a task needs
  `iam:PassRole` on the ops task's two roles. **The account's Deployer role does not have it** (AccessDenied on
  `iam:PassRole`).

Only `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_NAME` and `FIGBLOOM_BOOTSTRAP_CONFIRM` are passed through. Never pass
a secret: anyone who can describe the task can read its overrides.

Rotating the session-mint key is a deliberate procedure: `apps/api/docs/SESSION-HMAC-PROVISIONING.md`.
The key in Secrets Manager (`figbloom/schools-api/session-mint-hmac-key`) must end up matching the database's
active key. `release` never changes the database's key: on a mismatch it stops with exit 2.

## Secrets (Secrets Manager, all generated, under `figbloom/schools-api/`)

| Name | Used by | Note |
|---|---|---|
| `db-owner` | `release`, ops task | RDS master user `figbloom_owner`; owns the tables |
| `app-db-password` | API | `figbloom_app` |
| `worker-db-password` | worker | `figbloom_worker` |
| `session-mint-hmac-key` | API, `release` | see rotation above |
| `idempotency-fingerprint-key` | API | |
| `mfa-encryption-key` | API | **Encrypts every user's two-step secret. Never change or delete it.** |
| `resend-api-key` | API | Created as a random placeholder (e-mail off). Store the real key as below. |

### Turning on e-mail (Resend)

1. In Resend, verify the domain **figbloom.org**. The senders are `no-reply@figbloom.org` (accounts) and `billing@figbloom.org` (invoices), set in `lib/settings.ts`.
2. Store the key without typing it into the command line. Put it in a file, store it, then delete the file:
   ```sh
   aws secretsmanager put-secret-value --profile figbloom-prod --region eu-west-1 \
     --secret-id figbloom/schools-api/resend-api-key --secret-string file://resend-key.txt
   ```
3. `aws ecs update-service --profile figbloom-prod --region eu-west-1 --cluster figbloom-schools-api-prod --service api --force-new-deployment`.
   The API log then says `"msg":"account_email","outcome":"resend"`.

From then on, the API e-mails invitations and password resets **instead of** handing the one-time code to whoever issued it. The links open `https://schoolmanagement.figbloom.org/accept-invite` and `/reset-password`, so they only work once that site runs the API build. A send that Resend refuses falls back to handing the code to the issuer (log line `account_email_failed`).

After changing a secret's value, force new tasks:
`aws ecs update-service --cluster figbloom-schools-api-prod --service api --force-new-deployment`.

## Not set up yet (the API answers "not configured" for these)

- SMS and WhatsApp. E-mail is Resend, above.
- M-Pesa or PayHero.
- Push notifications (FCM).
- Document storage (S3).
- Bloom AI.

Each needs its provider account first. Then its variables go into Secrets Manager and the task definition in
`lib/service-stack.ts`. The full list is in `apps/api/env.example`.

Also not set up:

- Alarms. The other apps have an SNS topic and CloudWatch alarms; copy their pattern.
- A deploy pipeline from GitHub. Deploys run from a signed-in machine.
- ECS Exec.
- A standby database (`multiAz`).

## Recovery

- **A first deploy of `SchoolsApi-prod` rolled back** (for example, the circuit breaker stopped tasks that never became healthy). The three log groups are kept by design, so a plain re-deploy fails with "already exists". Deploy with `--import-existing-resources` so CloudFormation adopts them:
  `CDK_REQUIRE_APPROVAL=never sh infra/scripts/cdk.sh deploy --import-existing-resources`.
- **The shared load balancer answers 504** for our host: its security group allows no outbound traffic except each app's own rule (ours: `EdgeEgressToApi`, port 4100).
- **Database:** point-in-time restore for the last 14 days (automated backups). There is a final snapshot if the instance is ever deleted.
- **Secrets:** kept on stack deletion. A restored database needs the same `db-owner` password, the same session-mint key and the same MFA encryption key.
- **Logs:**
  - API and worker: `/figbloom/schools-api/api` and `/figbloom/schools-api/worker`, kept 90 days.
  - Release and ops: `/figbloom/schools-api/ops`, kept 7 days.
  - PostgreSQL: `/aws/rds/instance/figbloom-schools-api-prod/postgresql`, kept 30 days. Bound parameters are never logged.

## Working on this folder

```sh
cd infra
npm ci
npm run typecheck
npm test          # what must stay true of the stacks (no AWS access needed)
npx cdk synth -c account=111111111111 -c certificateArn=arn:aws:acm:eu-west-1:111111111111:certificate/x
```

If the shared platform changes (new export names, another rule priority taken, a different idle timeout),
update `lib/platform.ts` and `lib/settings.ts` first.

Rehearse image changes locally before deploying:

```sh
docker build -f infra/api/Dockerfile -t figbloom-api .
```

Then run it against a Postgres 16 that has TLS and a non-superuser owner with CREATEROLE, as RDS does.
