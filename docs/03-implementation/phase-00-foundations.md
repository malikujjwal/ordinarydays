# Phase 0 — Foundations

## Goal

At the end of this phase the project exists as a running system with no product in it. An
AWS account is open on the Paid Plan with budget alarms already firing on the first cent,
the domain is registered, CDK is bootstrapped, and eight stacks synthesise. A monorepo
with five workspaces builds, lints, type-checks and tests in one command. A single Lambda
behind an HTTP API answers `GET /v1/health` on `https://api.dev.ordinarydays.app`. An Expo
app renders on the iOS simulator and in a browser from the same source file, calls that
endpoint through the shared typed client, and displays the returned build SHA. GitHub
Actions deploys all of it on merge to `main` without a long-lived AWS key existing
anywhere. None of this is user-facing; all of it is the thing every later phase stands on.

## Prerequisites

| # | Item | Notes |
| --- | --- | --- |
| 1 | A macOS machine with Xcode and the iOS simulator | Required for the simulator target. EAS Build removes the Mac requirement for *release* builds later, not for local simulator work. |
| 2 | Node 22.x, `pnpm` 9.x, `git`, Docker Desktop | Node version pinned in `.nvmrc`; `corepack enable` for pnpm. |
| 3 | A GitHub account and an empty repository `ordinarydays` | Private. Branch protection is configured in P0-28. |
| 4 | A payment method for AWS and roughly $15 for the domain | The domain is the only spend in this phase. |
| 5 | An email address you will control in five years | `aws@ordinarydays.app` behind a forwarding rule is ideal, but it does not exist until the domain is registered — use a permanent personal address for signup and change the alternate contacts after P0-04. |
| 6 | A password manager and a TOTP app with a backed-up seed | Root MFA depends on it. |
| 7 | The canonical docs read in full | [`../02-architecture/infrastructure.md`](../02-architecture/infrastructure.md), [`../02-architecture/tech-stack.md`](../02-architecture/tech-stack.md), [`../02-architecture/aws-services.md`](../02-architecture/aws-services.md). |

An Apple Developer Program membership is **not** required in Phase 0. It is a Phase 4
prerequisite and a Phase 1 prerequisite for Sign in with Apple only.

## Deliverables

- [ ] AWS account open, on the **Paid Plan**, root hardened, MFA on, no root access keys.
- [ ] A `$1` bootstrap budget and a Cost Anomaly Detection monitor alerting by email,
      created **before** any resource is deployed.
- [ ] `ordinarydays.app` registered in Route 53 with auto-renew and privacy protection on,
      and a public hosted zone.
- [ ] CDK bootstrapped in `us-east-1` with the `odays` qualifier.
- [ ] Monorepo at `apps/mobile`, `services/api`, `packages/shared`, `packages/ui`, `infra`
      with `pnpm install && pnpm turbo run build lint typecheck test` green from a clean
      clone.
- [ ] `AccountStack`, `DnsStack`, `DataStack`, `ApiStack`, `WebStack`, `ObservabilityStack`
      deployed to dev. (`AuthStack` and `SchedulerStack` are scaffolded but empty — Phases 1
      and 4 fill them.)
- [ ] `GET https://api.dev.ordinarydays.app/v1/health` returns `200` with the deployed git
      SHA.
- [ ] `https://dev.ordinarydays.app` serves the Expo web export over CloudFront with a
      valid certificate.
- [ ] The Expo app runs on the iOS simulator and on web from one `app/(app)/index.tsx`,
      calls `/v1/health` through `@od/shared`, and shows the SHA.
- [ ] `ci.yml`, `deploy-dev.yml`, `deploy-prod.yml`, `nightly.yml` in place; merge to `main`
      deploys dev with no AWS secret in GitHub.
- [ ] DynamoDB Local runs the same table schema as `DataStack`, verified by a test.
- [ ] `docs/generated/openapi.json` generated and checked in; CI fails when stale.

## Tasks

| ID | Title | Area | Depends on | Parallel-safe | Size |
| --- | --- | --- | --- | --- | --- |
| P0-01 | Create the AWS account and select the Paid Plan | infra | — | no | S |
| P0-02 | Harden the root account | infra | P0-01 | no | S |
| P0-03 | Create the bootstrap budget and anomaly monitor | infra | P0-02 | no | S |
| P0-04 | Create an administrative identity (IAM Identity Center) | infra | P0-02 | no | M |
| P0-05 | Register `ordinarydays.app` in Route 53 | infra | P0-04 | no | S |
| P0-06 | Bootstrap CDK with the `odays` qualifier | infra | P0-04 | no | S |
| P0-07 | Initialise the repository and pnpm workspaces | repo | — | yes | M |
| P0-08 | Toolchain config: Biome, lefthook, syncpack, tsconfig base | ci | P0-07 | no | M |
| P0-09 | Scaffold `packages/shared` with the exports map | shared | P0-08 | yes | M |
| P0-10 | Scaffold `packages/ui` | shared | P0-08 | yes | S |
| P0-11 | Scaffold the CDK app and `infra/lib/config.ts` | infra | P0-08 | yes | M |
| P0-12 | `NodeLambda` construct | infra | P0-11 | no | S |
| P0-13 | `AccountStack` | infra | P0-11, P0-06 | no | M |
| P0-14 | `DnsStack` | infra | P0-11, P0-05 | no | S |
| P0-15 | `DataStack` | infra | P0-11 | yes | M |
| P0-16 | Scaffold `services/api`: Hono app and middleware chain | api | P0-09 | no | L |
| P0-17 | `GET /v1/health` | api | P0-16 | no | S |
| P0-18 | `ApiStack` | infra | P0-12, P0-14, P0-15, P0-17 | no | L |
| P0-19 | `static-site` construct and `WebStack` | infra | P0-12, P0-14 | no | L |
| P0-20 | `ObservabilityStack` | infra | P0-18, P0-19 | no | M |
| P0-21 | Empty `AuthStack` and `SchedulerStack` shells | infra | P0-11 | yes | S |
| P0-22 | Scaffold `apps/mobile` (Expo Router, Metro workspace config) | mobile | P0-09, P0-10 | no | L |
| P0-23 | Shared HTTP client and the `health` endpoint function | shared | P0-09 | no | M |
| P0-24 | Hello-world screen on iOS and web calling `/v1/health` | mobile | P0-22, P0-23, P0-18 | no | M |
| P0-25 | Local development: DynamoDB Local, table script, local API server | api | P0-16, P0-15 | yes | M |
| P0-26 | Vitest configuration and coverage gates | ci | P0-09, P0-16 | yes | M |
| P0-27 | OpenAPI generation harness | shared | P0-09 | yes | M |
| P0-28 | CDK assertion tests | infra | P0-15, P0-18, P0-19 | yes | M |
| P0-29 | Bundle-size check script | ci | P0-16 | yes | S |
| P0-30 | `ci.yml` — validate and synth | ci | P0-26, P0-27, P0-29, P0-13 | no | L |
| P0-31 | `deploy-dev.yml` and `scripts/smoke.mjs` | ci | P0-30, P0-18, P0-19 | no | M |
| P0-32 | `deploy-prod.yml` and the release tag flow | ci | P0-31 | no | M |
| P0-33 | `nightly.yml` | ci | P0-30 | yes | S |
| P0-34 | GitHub environments, branch protection, signed commits | ci | P0-30 | no | S |
| P0-35 | First deploy, SNS confirmation, cost allocation tags | infra | P0-18, P0-19, P0-20 | no | S |

Tasks P0-10, P0-21, P0-29 and P0-33 are mechanical and have no detail subsection: follow
the referenced canonical doc verbatim.

---

### P0-01 — Create the AWS account and select the Paid Plan

**What to build.** An AWS account that will still exist in six months. This is not a
formality: the default choice at signup closes the account.

**Files.** None. Record the account ID, the sign-in email and the account alias in your
password manager. Nothing about this step goes in git.

**Approach, step by step.**

1. Open <https://portal.aws.amazon.com/billing/signup> in a private browser window so a
   cached AWS session does not attach the new account to an existing identity.
2. Enter the permanent email address from the prerequisites and an account name
   (`ordinarydays`). AWS emails a verification code; enter it.
3. Set a long random root password from your password manager.
4. Choose **Personal** account type. Enter the contact details. They must be real — AWS
   verifies the phone number.
5. Enter a payment method. AWS places a temporary ~$1 authorisation hold.
6. Verify the phone number by SMS or voice call.
7. **The trap.** The final signup step asks you to choose a support plan and, in current
   signups, a *plan* for the account itself. New accounts default to the **Free Plan**,
   which grants up to $200 of credits and **closes the account after six months**. Select
   the **Paid Plan**. If the signup flow does not offer the choice, complete signup and
   then go to **Billing and Cost Management → Account settings** (or the *Free tier* page)
   and upgrade to the Paid Plan immediately.
8. For the *support* plan choose **Basic (free)**. That is a different question from step 7
   and Basic is correct.
9. Verify: Billing and Cost Management → *Free tier* shows the account plan as **Paid**.
   Do not proceed until it does.

**Why upgrading loses nothing.** The always-free allowances — Lambda 1M requests and
400,000 GB-seconds, DynamoDB 25 GB, CloudFront 1 TB and 10M requests, Cognito 10,000 MAU —
apply on both plans. The 12-month allowances (API Gateway 1M HTTP API calls, S3 5 GB, SES
3,000 message charges) also apply on both. What the Free Plan adds is credits with an
expiry attached to the account's life; what it costs is the account.

**Edge cases.** If signup is rejected for a payment reason, do not create a second account
with a different email — resolve it with AWS Support on the first one. Two accounts means
two free-tier clocks and a billing mess.

**Tests.** Manual verification only, recorded in the runbook notes: account ID captured,
plan reads "Paid", alternate contacts set.

---

### P0-02 — Harden the root account

**What to build.** A root account nobody uses.

**Approach.**

1. Signed in as root: **IAM → Security credentials**. Enable MFA. Prefer a hardware key; a
   TOTP app is acceptable if the seed is backed up somewhere you will still have in five
   years. Losing root MFA with no recovery path means an AWS Support identity-verification
   process measured in days.
2. On the same page, confirm there are **no root access keys**. If one exists, delete it.
   A root access key has no legitimate use in this project.
3. Billing and Cost Management → **Account settings** → *IAM user and role access to
   Billing Information* → **Activate**. Without this an administrative IAM identity cannot
   read the bill, and every cost check requires signing in as root.
4. Set the alternate contacts (billing, operations, security) to an address you monitor.
5. Write down the five legitimate uses of root and never exceed them: closing the account,
   changing the support plan, changing the account email, changing the payment method, and
   enabling billing access (already done).

**Tests.** Manual. `aws iam get-account-summary` later shows `AccountMFAEnabled: 1`.

---

### P0-03 — Create the bootstrap budget and anomaly monitor

**What to build.** A tripwire that fires on the first cent, created before any resource
exists. The permanent budgets arrive with `AccountStack` in P0-13; this one covers the
window in between, which is exactly when a mis-typed CDK construct is most likely.

**Files.** None in git. Run from the console or, once P0-04 gives you CLI access, from a
shell. The console path is fine and needs no credentials setup.

**Approach (console).** Billing and Cost Management → **Budgets** → Create budget →
*Customize (advanced)* → **Cost budget** → name `od-bootstrap-zero-spend`, period
**Monthly**, budgeted amount **$1.00**. Add an alert: threshold **1% of budgeted amount**,
trigger **Actual**, email your address. Create.

**Approach (CLI, after P0-04).** Exactly the commands in
[`../02-architecture/infrastructure.md#34-budgets-before-anything-else`](../02-architecture/infrastructure.md#34-budgets-before-anything-else).

Then Billing and Cost Management → **Cost Anomaly Detection** → Create monitor → monitor
type **AWS services** → alert subscription, threshold **$5**, same email, frequency
**Individual alerts**.

**Edge cases.** Budget alerts are evaluated a few times a day, not in real time; they are a
safety net, not a circuit breaker. The things that actually stop spend are Lambda reserved
concurrency, API Gateway throttling and S3 lifecycle rules, all of which arrive with the
stacks. Do not treat the budget as a control.

**Tests.** Manual: the budget appears in the console and a test email arrives when you
confirm the subscription.

---

### P0-04 — Create an administrative identity

**What to build.** Short-lived administrative credentials on your laptop, with no
long-lived access key anywhere.

**Approach.**

1. Console → **IAM Identity Center** → Enable. Choose `us-east-1` as the identity store
   region to match everything else. Identity Center is free.
2. **Permission sets** → Create → *Predefined* → `AdministratorAccess`. Set the session
   duration to 4 hours.
3. **Users** → create a user for yourself with your email; complete the invitation email.
4. **AWS accounts** → select the account → Assign users → your user, with the
   `AdministratorAccess` permission set.
5. Locally:

   ```bash
   aws configure sso --profile od-admin
   # SSO start URL:  https://d-xxxxxxxxxx.awsapps.com/start
   # SSO region:     us-east-1
   # Account:        <your account id>
   # Role:           AdministratorAccess
   # CLI region:     us-east-1
   # Output format:  json

   aws sso login --profile od-admin
   aws sts get-caller-identity --profile od-admin
   ```

6. `export AWS_PROFILE=od-admin` in your shell profile. Every command in this doc assumes
   it.

**Edge cases.** If Identity Center cannot be enabled (some account states block it),
fall back to one IAM user `od-admin` with `AdministratorAccess`, MFA enforced, and **no**
access key — use `aws sts get-session-token` with an MFA code to mint temporary
credentials. Never create a long-lived access key on a laptop; it is the most common cause
of a compromised AWS account.

**Tests.** `aws sts get-caller-identity` returns an assumed-role ARN containing
`AWSReservedSSO_AdministratorAccess`, not an IAM user ARN.

---

### P0-05 — Register `ordinarydays.app` in Route 53

**What to build.** The domain and its public hosted zone.

**Approach.**

```bash
aws route53domains check-domain-availability --region us-east-1 \
  --domain-name ordinarydays.app

aws route53domains list-prices --region us-east-1 --tld app \
  --query 'Prices[0].RegistrationPrice'
```

Register through the **console** (Route 53 → Registered domains → Register domains). The
CLI path needs a fully-formed contact JSON and the console validates it. Enable **privacy
protection** and **auto-renew**. Registration creates a public hosted zone automatically.

```bash
aws route53 list-hosted-zones-by-name --dns-name ordinarydays.app \
  --query 'HostedZones[0].Id' --output text
```

Record the zone ID in the runbook notes. CDK looks the zone up by name with
`HostedZone.fromLookup`, so the ID is not needed in config, but you will want it when
debugging.

Now change the AWS account's alternate contacts and the alert email in
`infra/lib/config.ts` to `alerts@ordinarydays.app`, and set up forwarding for it at your
mail provider.

**Edge cases.** `.app` is on the HSTS preload list, so every hostname under it is
HTTPS-only in browsers by construction. That is a small free security win and it means a
plain-HTTP fallback will never work — plan for that when testing locally against a device.

**Tests.** `dig NS ordinarydays.app` returns four AWS name servers.

---

### P0-06 — Bootstrap CDK with the `odays` qualifier

**Approach.**

```bash
cd infra
pnpm install

export CDK_DEFAULT_ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
export CDK_DEFAULT_REGION=us-east-1

pnpm exec cdk bootstrap "aws://${CDK_DEFAULT_ACCOUNT}/us-east-1" \
  --qualifier odays \
  --cloudformation-execution-policies arn:aws:iam::aws:policy/AdministratorAccess
```

The qualifier must also appear in `infra/cdk.json` under
`"@aws-cdk/core:bootstrapQualifier": "odays"`, exactly as in
[`../02-architecture/infrastructure.md#36-bootstrap-cdk`](../02-architecture/infrastructure.md#36-bootstrap-cdk).
A mismatch produces a synth-time error naming the missing SSM parameter, which is the
clearest failure mode of the two, but it still costs a debugging session.

**Edge cases.** Bootstrapping is idempotent, but re-bootstrapping with a *different*
qualifier creates a second, unused set of roles and buckets. Get it right once.

**Tests.** `aws ssm get-parameter --name /cdk-bootstrap/odays/version` returns a version
number ≥ 20.

---

### P0-07 — Initialise the repository and pnpm workspaces

**Files to create.**

```
.gitignore  .nvmrc  .npmrc  package.json  pnpm-workspace.yaml  turbo.json
README.md   docker-compose.yml
apps/mobile/package.json
services/api/package.json
packages/shared/package.json
packages/ui/package.json
infra/package.json
```

**Approach.** `pnpm-workspace.yaml` and `turbo.json` are given verbatim in
[`../02-architecture/tech-stack.md#1-repository-layout`](../02-architecture/tech-stack.md#1-repository-layout).
Package names are `@od/mobile`, `@od/api`, `@od/shared`, `@od/ui`, `@od/infra`. The root
`package.json` carries **scripts only** and no runtime dependencies.

`.npmrc`:

```
save-exact=true
strict-peer-dependencies=false
node-linker=isolated
```

`.nvmrc` contains `22`. Root `package.json#engines` pins `"node": ">=22 <23"`. The CDK
Lambda runtime is `NODEJS_22_X`. A CI check asserts all three agree (P0-30).

`.gitignore` must cover `node_modules`, `dist`, `.expo`, `cdk.out`, `.turbo`,
`.dynamodb-data`, `.env*` except `.env.example`, `*.p8`, `*.p12`, `*.mobileprovision`,
`coverage`, `.DS_Store`.

**Edge cases.** `node-linker=isolated` is pnpm's default and is what catches phantom
dependencies; do not switch to `hoisted` to fix a Metro resolution problem — fix the Metro
config instead (P0-22).

**Tests.** `pnpm install` from a clean clone succeeds. `pnpm -r exec node -e "0"` runs in
all five workspaces.

---

### P0-08 — Toolchain config: Biome, lefthook, syncpack, tsconfig base

**Files.** `biome.json`, `lefthook.yml`, `.syncpackrc`, `tsconfig.base.json`, and a
`tsconfig.json` per workspace extending it.

**Approach.** `tsconfig.base.json` sets `strict: true`,
`noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`,
`moduleResolution: "bundler"`, `target: "ES2023"`, `verbatimModuleSyntax: true`,
`skipLibCheck: true`. Workspaces extend it and set only `outDir`, `rootDir` and `types`.

`biome.json` at the root with per-workspace overrides. Enable `noUnusedVariables`,
`useExhaustiveDependencies`, `noExplicitAny`, and import sorting (`organizeImports`).
Formatter: 90-column line width, single quotes, trailing commas, 2-space indent — matching
the docs' wrap.

`lefthook.yml` runs `biome check --write --staged` and `gitleaks protect --staged` on
pre-commit.

`.syncpackrc` pins one version per dependency name across all workspaces. Divergent React
or React Native versions between `apps/mobile` and `packages/ui` produce hook-dispatcher
errors that cost a day to diagnose.

**Tests.** `pnpm exec biome ci .` passes on the empty tree. `pnpm exec syncpack list-
mismatches` reports none. A deliberate `any` in a scratch file fails `biome ci`.

---

### P0-09 — Scaffold `packages/shared` with the exports map

**Files.**

```
packages/shared/package.json          (exports map exactly as tech-stack.md §3.3)
packages/shared/tsconfig.json
packages/shared/src/index.ts
packages/shared/src/errors.ts
packages/shared/src/constants.ts
packages/shared/src/schemas/common.ts
packages/shared/src/types/index.ts
packages/shared/src/client/http.ts     (P0-23 fills this)
```

**Approach.** `errors.ts` exports the closed `ErrorCode` union from
[`../02-architecture/api-contract.md#1-shape`](../02-architecture/api-contract.md#1-shape)
plus `not_implemented` and `upgrade_required` from
[`../02-architecture/tech-stack.md#44-error-to-http-mapping`](../02-architecture/tech-stack.md#44-error-to-http-mapping),
and the `AppErrorBody` type. `constants.ts` exports `MAX_PARTICIPANTS = 50`,
`MAX_AGENDA_DAYS = 62`, `MAX_UPLOAD_BYTES = 10 * 1024 * 1024`, `MAX_LIST_ITEMS = 500`,
`MAX_TITLE_LEN = 200`, `MAX_NOTES_LEN = 4000`, `MAX_REMINDERS_PER_ACTIVITY = 5`,
`MAX_ACTIVE_SERIES = 200`, `OVERDUE_WINDOW_DAYS = 30`.

`schemas/common.ts` exports `isoDate`, `hhmm`, `ianaTimezone`, `cents`, `ulidId(prefix)`,
`cursor`. These are the primitives every other schema composes.

Nothing in this package may import React, React Native, an AWS SDK client, or
`process.env`. Add a lint rule or a unit test that asserts it — see
[`../02-architecture/tech-stack.md#52-what-must-never-enter-shared`](../02-architecture/tech-stack.md#52-what-must-never-enter-shared).

> **Decision:** resolve open question OQ-11 (`zod` v3 vs v4) in this task, not later.
> Check whether the `zod-to-openapi` package in the lockfile supports v4. If it does not,
> pin `zod@3` and record the pin with a one-line comment in `package.json`. Migrating
> schemas after Phase 1 touches every file in `src/schemas/`.

**Tests.** A Vitest test importing every subpath export and asserting it resolves. A test
that greps the built output for `react` and `@aws-sdk` and fails on a hit.

---

### P0-11 — Scaffold the CDK app and `infra/lib/config.ts`

**Files.** The tree in
[`../02-architecture/infrastructure.md#1-cdk-app-layout`](../02-architecture/infrastructure.md#1-cdk-app-layout),
with `bin/ordinarydays.ts`, `lib/config.ts`, `cdk.json`, and one empty stack file per
stack.

**Approach.** `lib/config.ts` is the Zod-validated `EnvConfig` given verbatim in
[`../02-architecture/infrastructure.md#22-context-driven-config`](../02-architecture/infrastructure.md#22-context-driven-config).
Fill in the `prod` object that the doc elides: `logRetentionDays: ONE_MONTH`,
`apiReservedConcurrency: 50`, `pointInTimeRecovery: true`,
`removalPolicy: RETAIN`, `domain: 'ordinarydays.app'`, `apiDomain: 'api.ordinarydays.app'`,
`mediaDomain: 'media.ordinarydays.app'`, `webOrigins: ['https://ordinarydays.app']`.

`bin/ordinarydays.ts` instantiates `AccountStack` once and the per-stage stacks in a loop,
passing constructs as typed props — never `Fn::ImportValue` strings. Apply the five tags
from
[`../02-architecture/infrastructure.md#24-tags`](../02-architecture/infrastructure.md#24-tags)
at the app level.

**Edge cases.** The stage is selected by stack name (`cdk deploy 'od-*-dev'`), not by a
context flag. Do not add a `-c stage=` path; it is how dev config ends up in a prod stack.

**Tests.** `pnpm exec cdk synth 'od-*-dev'` succeeds and emits eight templates. A Vitest
test asserts `getConfig('prod').removalPolicy === RemovalPolicy.RETAIN`.

---

### P0-12 — `NodeLambda` construct

**Files.** `infra/lib/constructs/node-lambda.ts`.

**Approach.** Exactly the construct in
[`../02-architecture/infrastructure.md#13-the-shared-lambda-construct`](../02-architecture/infrastructure.md#13-the-shared-lambda-construct).
Every Lambda in the project goes through it so runtime, architecture, bundling format, log
retention and log level cannot drift. Keep the `banner` — an ESM bundle has no `require`
in scope and some transitive dependencies still emit one.

**Edge cases.** `sourceMap` is on in dev and off in prod. Source maps cost boot time; the
prod artifact ships them to the CDK asset bucket, not to the runtime.

**Tests.** A CDK assertion test: the synthesised function has `Runtime: nodejs22.x`,
`Architectures: ["arm64"]`, `LoggingConfig.LogFormat: JSON`.

---

### P0-15 — `DataStack`

**Files.** `infra/lib/stacks/data-stack.ts`,
`infra/lib/table-schema.ts` (shared with the local-table script).

**Approach.** Table `od-main-{stage}`, `PAY_PER_REQUEST`, `pk`/`sk` string keys, TTL
attribute `ttl`, one GSI `GSI1` on `gsi1pk`/`gsi1sk` with projection type **`INCLUDE`**
limited to the `AgendaItem` fields, per
[`../02-architecture/aws-services.md#14-amazon-dynamodb`](../02-architecture/aws-services.md#14-amazon-dynamodb).
Streams are **off** in Phase 0 (Phase 6 turns them on). PITR and deletion protection follow
`cfg`. Media bucket `od-media-{stage}-{account}` with all four Block Public Access settings
on, SSE-S3, the three lifecycle rules, and CORS allowing `PUT` from `cfg.webOrigins`.

The key schema lives in `infra/lib/table-schema.ts` and is imported by both this stack and
`services/api/scripts/create-local-table.ts`, so the two cannot drift.

**Edge cases.** The GSI projection is `INCLUDE`, not `ALL`. Getting this wrong is invisible
until the agenda query's cost and latency are wrong at scale, and changing a GSI projection
requires replacing the index.

**Tests.** CDK assertion test on key schema, GSI projection type and non-key attributes,
TTL attribute name, and bucket public-access-block settings. A separate test (P0-25)
asserts the local table script produces the same key schema.

---

### P0-16 — Scaffold `services/api`: Hono app and middleware chain

**Files.**

```
services/api/src/index.ts          handler = handle(app)
services/api/src/local.ts          @hono/node-server, dev only
services/api/src/app.ts            middleware chain + route mounting
services/api/src/middleware/{requestId,logger,errorHandler,cors,securityHeaders,
                             bodyLimit,routeSplit}.ts
services/api/src/lib/{ddb,logger,errors,config}.ts
services/api/src/routes/health.ts
services/api/package.json  tsconfig.json  vitest.config.ts
```

**Approach.** Build the middleware chain in the exact order in
[`../02-architecture/tech-stack.md#42-middleware-chain-in-order`](../02-architecture/tech-stack.md#42-middleware-chain-in-order).
Phase 0 ships entries 1–7 and 12; `auth`, `rateLimit` and `idempotency` are stubbed as
pass-throughs with a `// Phase 1` comment and a failing-by-default guard so they cannot be
forgotten: `routeSplit` throws `not_found` for any `/v1/*` path other than `/v1/health`
until Phase 1 mounts the private routes.

`lib/config.ts` parses `process.env` with Zod at module load and throws on a missing
variable. `lib/logger.ts` is a module-scope pino instance with the redaction paths from
[`../02-architecture/security-privacy.md`](../02-architecture/security-privacy.md) §4.
`lib/ddb.ts` creates one `DynamoDBDocumentClient` at module scope with
`removeUndefinedValues: true` and points at `DDB_ENDPOINT` when it is set — that is the
only local/deployed branch permitted in runtime code.

`lib/errors.ts` defines `AppError` and the `ErrorCode → HTTP status` table from
[`../02-architecture/tech-stack.md#44-error-to-http-mapping`](../02-architecture/tech-stack.md#44-error-to-http-mapping).
`errorHandler` translates `ZodError` to `validation_failed` with path-mapped `details[]`,
and the DynamoDB exception mappings, and guarantees that a `500` body is always the literal
string `"An unexpected error occurred."`.

**Edge cases.** CORS must answer `OPTIONS` before any auth decision. `bodyLimit` must run
before body parsing so a 5 MB body is never buffered into a JS object.

**Tests.** Vitest against `app.fetch` directly, no AWS: an unknown path returns the `404`
envelope; a thrown `AppError` maps to the right status and body; `X-Request-Id` is echoed;
a 300 KB body returns `413`; `OPTIONS` from an allowed origin returns the CORS headers and
from a disallowed origin does not.

---

### P0-17 — `GET /v1/health`

**What to build.** The endpoint every smoke test and every alarm depends on.

**Files.** `services/api/src/routes/health.ts`.

**Approach.** Unauthenticated, mounted before `routeSplit`'s auth requirement. Returns:

```json
{ "data": { "status": "ok", "sha": "…", "stage": "dev", "coldStart": true },
  "meta": { "requestId": "req_…" } }
```

`sha` comes from a `GIT_SHA` environment variable set by CDK at deploy time from
`process.env.GITHUB_SHA ?? 'local'`. `coldStart` is a module-scope boolean flipped to
`false` after the first invocation. The handler performs **no** I/O — no DynamoDB call —
so it stays a pure liveness signal and cannot fail because the table is throttled.

**Edge cases.** `Cache-Control: no-store` (the `securityHeaders` default) matters here:
a cached health response makes a deploy look successful when it was not.

**Tests.** Unit: returns `200`, the envelope shape, and the SHA from the environment.
The smoke script in P0-31 asserts the returned SHA equals the deployed commit.

---

### P0-18 — `ApiStack`

**Files.** `infra/lib/stacks/api-stack.ts`.

**Approach.** A `NodeLambda` for `od-api-{stage}` with `entry` pointing at
`services/api/src/index.ts`, 1024 MB, 15 s timeout, reserved concurrency from `cfg`. Grant
it read/write on the `DataStack` table and its index, and `s3:PutObject`/`GetObject` on the
media bucket prefix — nothing wider.

Publish a version on every deploy and create the `live` alias, and point the
`HttpLambdaIntegration` at the **alias**, not `$LATEST`, per
[`../02-architecture/infrastructure.md#44-reverting-a-bad-lambda`](../02-architecture/infrastructure.md#44-reverting-a-bad-lambda).
Doing this on day one is what makes a seconds-long rollback possible later; retrofitting it
after an incident is not an option.

`HttpApi` (v2) with a single `$default` route, payload format 2.0, no authorizer. Custom
domain `cfg.apiDomain` with the regional certificate from `DnsStack`, an API mapping, and
an A-record alias in the hosted zone. Throttling: burst 100, rate 50 rps. Access logs to a
CloudWatch log group with `cfg.logRetentionDays`, JSON format.

Environment variables: `TABLE_NAME`, `MEDIA_BUCKET`, `STAGE`, `LOG_LEVEL`, `GIT_SHA`,
`WEB_ORIGINS`. Identifiers only — nothing secret.

**Edge cases.** The custom domain's A record and the certificate must both exist before the
mapping; CDK orders this correctly only if the certificate is passed as a construct.
Passing an ARN string produces a race on first deploy.

**Tests.** CDK assertion tests: exactly one route (`$default`), the integration URI
references the alias, `PayloadFormatVersion: 2.0`, throttle settings present, log group
retention matches `cfg`. Post-deploy: `curl https://api.dev.ordinarydays.app/v1/health`
returns `200`.

---

### P0-19 — `static-site` construct and `WebStack`

**Files.** `infra/lib/constructs/static-site.ts`,
`infra/lib/stacks/web-stack.ts`,
`infra/lib/functions/uri-rewrite.js` (CloudFront Function source).

**Approach.** Private S3 bucket `od-web-{stage}-{account}` with versioning on and all
public access blocked; a CloudFront distribution with Origin Access Control (not OAI);
`PRICE_CLASS_100`; HTTP/2 and HTTP/3; `REDIRECT_TO_HTTPS`; TLS 1.2 minimum; the edge
certificate from `DnsStack`; default root object `index.html`.

Two cache policies: `/_expo/static/*` gets `max-age=31536000, immutable`; `*.html` gets
`max-age=0, must-revalidate`.

The viewer-request CloudFront Function rewrites extensionless paths to `path/index.html`
so Expo Router's static export resolves, and rewrites unmatched dynamic segments
(`/invite/<token>`) to the route's pre-rendered shell. CloudFront Functions, not
Lambda@Edge — see
[`../02-architecture/aws-services.md#16-amazon-cloudfront`](../02-architecture/aws-services.md#16-amazon-cloudfront).

A response-headers policy with HSTS, `X-Content-Type-Options`, `Referrer-Policy` and a
`Permissions-Policy` denying camera, microphone and geolocation. The full Content Security
Policy is Phase 4 (P4-02); ship a report-only CSP now so violations are visible early.

Also create the **media** distribution here (`cfg.mediaDomain`) over the `DataStack` media
bucket, so every distribution and cache policy lives in one file.

`BucketDeployment` uploads `apps/mobile/dist` and invalidates `/index.html` and `/*.html`
only — hashed assets are immutable by name and invalidating them wastes quota.

**Edge cases.** `BucketDeployment` fails at synth if `apps/mobile/dist` does not exist.
Guard it: skip the deployment construct when the directory is absent, so `cdk synth` works
before the first web build. CI always builds the web export before deploying.

**Tests.** CDK assertion tests on OAC presence, the absence of any public bucket policy,
the two cache policies, and the function association. Post-deploy: `curl -I
https://dev.ordinarydays.app` returns `200` with `strict-transport-security`, and
`https://dev.ordinarydays.app/some/deep/route` returns the app shell, not `403`.

---

### P0-20 — `ObservabilityStack`

**Files.** `infra/lib/stacks/observability-stack.ts`,
`infra/lib/constructs/alarm.ts`, `infra/observability/queries/*.txt`.

**Approach.** One SNS topic `od-alerts-{stage}` with an email subscription to
`cfg.alertEmail`. The eight alarms from
[`../02-architecture/aws-services.md#112-amazon-cloudwatch-logs-metrics-alarms`](../02-architecture/aws-services.md#112-amazon-cloudwatch-logs-metrics-alarms),
of which Phase 0 can wire five (`api-5xx`, `api-errors`, `api-throttles`,
`api-invocations-spike`, `api-p95-latency`); `ddb-throttles` too. `ses-bounce-rate` and
`reminder-errors` arrive with the resources they watch (Phases 1 and 4). One CloudWatch
dashboard. Check in the Log Insights queries for the common investigations.

Publish **no custom metrics** — the always-free allowance is 10 and every one beyond is
$0.30/month. Business counters come from structured logs via Log Insights.

**Edge cases.** An unconfirmed SNS email subscription means every alarm goes nowhere,
silently. P0-35 confirms it explicitly.

**Tests.** CDK assertion test counting alarms and asserting each has an SNS action.

---

### P0-22 — Scaffold `apps/mobile`

**Files.**

```
apps/mobile/app/_layout.tsx           providers: Query, theme, gesture root
apps/mobile/app/(app)/_layout.tsx
apps/mobile/app/(app)/index.tsx
apps/mobile/app/+not-found.tsx
apps/mobile/app.config.ts
apps/mobile/metro.config.js
apps/mobile/eas.json                  profiles only; EAS project linked in Phase 4
apps/mobile/src/lib/queryClient.ts
apps/mobile/src/lib/apiClient.ts
apps/mobile/tsconfig.json  package.json
```

**Approach.** `npx create-expo-app` with the SDK 54 blank-TypeScript template, then delete
its scaffolding down to the tree above and wire Expo Router. `app.config.ts` is exactly the
profile-driven config in
[`../02-architecture/infrastructure.md#64-pointing-the-client-at-local--dev--prod`](../02-architecture/infrastructure.md#64-pointing-the-client-at-local--dev--prod),
including the distinct bundle identifiers and URL schemes per profile and
`web.output: "static"`.

`metro.config.js` is the workspace-aware config in
[`../02-architecture/tech-stack.md#33-consuming-the-shared-package`](../02-architecture/tech-stack.md#33-consuming-the-shared-package)
verbatim. Without `watchFolders` and `disableHierarchicalLookup`, edits to
`packages/shared` will not hot-reload and will occasionally resolve to a stale copy.

`queryClient.ts` uses the defaults in the same doc §3.4 (60 s `staleTime`, 7-day `gcTime`,
`networkMode: 'offlineFirst'`). Persistence is Phase 2 (P2-28); Phase 0 ships the plain
client.

**Edge cases.** React 19 plus React Native Web 0.20 requires that `react`, `react-dom`,
`react-native` and `react-native-web` versions match exactly across `apps/mobile` and
`packages/ui`. `syncpack` enforces it; run `npx expo install --fix` after any change and
`npx expo-doctor` before committing.

**Tests.** `pnpm --filter @od/mobile exec expo export --platform web` produces `dist/`.
`npx expo-doctor` passes. A Vitest render test on the root layout is not required at this
stage; the E2E harness lands in Phase 1.

---

### P0-23 — Shared HTTP client and the `health` endpoint function

**Files.** `packages/shared/src/client/http.ts`,
`packages/shared/src/client/endpoints/health.ts`,
`packages/shared/src/client/index.ts`,
`packages/shared/src/schemas/health.ts`.

**Approach.** `http.ts` is a `fetch` wrapper taking an injected `fetch` implementation, a
base URL, and a token provider. It sets `X-Request-Id`, `X-Client-Timezone` and
`X-Client-Version` on every request, injects `Authorization` when a token is available,
parses the `{ data, meta }` / `{ error }` envelope, maps error bodies onto a typed
`ApiError` carrying the `ErrorCode`, and retries idempotent `GET`s up to three times on
network failure and `5xx` with jittered backoff. It never retries a `POST` without an
`Idempotency-Key`.

Response validation: `safeParse` against the endpoint's Zod schema. In `dev` and `test`
builds a parse failure throws; in production it logs a warning and returns the raw body — a
server that added a field must not break a shipped app.

**Edge cases.** No `process.env` reads in this package. Configuration arrives as
constructor arguments from `apps/mobile/src/lib/apiClient.ts`, which is where Expo's
`extra` is read.

**Tests.** Vitest with a stubbed `fetch`: envelope parsing, error mapping for each
`ErrorCode`, retry counts and backoff on `500` and on a network throw, no retry on `400`,
header injection, and the dev-throws / prod-warns response-validation split.

---

### P0-24 — Hello-world screen on iOS and web

**What to build.** The proof that the whole loop closes.

**Files.** `apps/mobile/app/(app)/index.tsx`,
`apps/mobile/src/lib/apiClient.ts`,
`apps/mobile/src/features/health/hooks/useHealth.ts`.

**Approach.** One screen, one `useQuery` in a feature hook calling
`api.getHealth()`. Render the stage, the SHA and the round-trip time. `apiClient.ts`
constructs the shared client from `Constants.expoConfig.extra.apiBaseUrl`. Layering rule
from
[`../02-architecture/tech-stack.md#32-layering`](../02-architecture/tech-stack.md#32-layering)
applies from the first screen: the route calls a feature hook, the hook is the only place
`useQuery` appears, and the hook calls the shared client. A `fetch` call in a component is
a review rejection even here.

**Edge cases.** On the iOS simulator `http://localhost:3000` reaches the host machine
directly. On a physical device use the LAN IP and add an ATS exception in the **dev** app
config only. Never in prod.

**Verification, both platforms:**

```bash
pnpm --filter @od/mobile ios       # simulator boots, screen shows the dev SHA
pnpm --filter @od/mobile web       # localhost:8081 shows the same
```

**Tests.** A Playwright test against the exported web build asserting the SHA element is
present and non-empty (wired in P0-30). A Maestro flow is deferred to Phase 1, when there
is a screen worth driving.

---

### P0-25 — Local development: DynamoDB Local, table script, local API server

**Files.** `docker-compose.yml` (root),
`services/api/scripts/create-local-table.ts`,
`services/api/scripts/seed-dev.ts`,
`services/api/src/local.ts`,
`services/api/.env.example`.

**Approach.** `docker-compose.yml` verbatim from
[`../02-architecture/infrastructure.md#61-dynamodb-local`](../02-architecture/infrastructure.md#61-dynamodb-local).
`create-local-table.ts` imports `infra/lib/table-schema.ts` so the local table and the CDK
table share one definition.

```bash
docker compose up -d
pnpm --filter @od/api ddb:create-table
pnpm --filter @od/api ddb:seed
pnpm --filter @od/api dev            # tsx watch src/local.ts, port 3000
```

`.env.example` documents every variable with placeholder values and is the only `.env*`
file in git.

**Edge cases.** `AUTH_MODE=dev-bypass` must be guarded by an assertion that
`STAGE === 'local'`, and a unit test must assert the guard, so it cannot exist in a
deployed build. Write both now, before there is any auth to bypass — retrofitting the guard
after the bypass exists is how it ships.

**Tests.** An integration test that starts against DynamoDB Local, creates the table,
round-trips an item, and asserts the local key schema equals the synthesised CDK table's
key schema attribute for attribute.

---

### P0-26 — Vitest configuration and coverage gates

**Files.** `vitest.workspace.ts` at the root, `vitest.config.ts` per workspace,
`packages/shared/vitest.config.ts` carrying the coverage thresholds.

**Approach.** `@vitest/coverage-v8`. Global thresholds: 70% statements repo-wide as a floor
that rises with each phase. Path-scoped thresholds at **100% statements and branches** for
`packages/shared/src/recurrence/**` and `packages/shared/src/money/**`, per the brief. Those
directories do not exist yet; configure the thresholds now with an `allowExternal: false`
and a placeholder file so the gate is live the moment the first line is written, rather
than being added after the code and tuned down to fit it.

**Tests.** Meta: a deliberately uncovered branch in the placeholder recurrence file fails
`pnpm turbo run test -- --coverage`.

---

### P0-27 — OpenAPI generation harness

**Files.** `packages/shared/src/openapi.ts`,
root script `gen:openapi`, output `docs/generated/openapi.json`.

**Approach.** Register each Zod schema with `zod-to-openapi` as it is written and emit the
document to `docs/generated/openapi.json`, which is **checked in**. In Phase 0 only
`/v1/health` is registered. CI regenerates and fails on a diff, so the spec cannot drift
from the schemas. This is how a new agent discovers the API without reading every handler.

**Tests.** `pnpm run gen:openapi && git diff --exit-code docs/generated/openapi.json`
passes; adding a field to a schema without regenerating fails it.

---

### P0-28 — CDK assertion tests

**Files.** `infra/test/*.test.ts` using `aws-cdk-lib/assertions` under Vitest.

**Approach.** One test file per stack. Assert the properties that would be expensive to get
wrong and invisible if they were: table key schema and GSI projection type, bucket public
access blocks, the API integration pointing at the alias, Lambda runtime and architecture,
log retention values per stage, alarm count and SNS actions, `RemovalPolicy.RETAIN` on prod
stateful resources, and the absence of any `AWS::EC2::NatGateway` anywhere in any
synthesised template.

**Edge cases.** Snapshot tests over whole templates are brittle and get regenerated
thoughtlessly. Assert named properties, not snapshots.

**Tests.** The tests are the deliverable. They run in `ci.yml`'s `validate` job.

---

### P0-30 — `ci.yml` — validate and synth

**Files.** `.github/workflows/ci.yml`, `scripts/check-bundle-size.mjs`,
`scripts/check-node-versions.mjs`.

**Approach.** The workflow in
[`../02-architecture/infrastructure.md#71-ciyml--validation-on-every-pr`](../02-architecture/infrastructure.md#71-ciyml--validation-on-every-pr)
verbatim, plus a `check-node-versions.mjs` step asserting `.nvmrc`,
`package.json#engines` and the CDK `Runtime.NODEJS_22_X` all agree, and an
`npx expo-doctor` step.

The `synth` job assumes `od-github-deploy-dev` through OIDC and posts `cdk diff` to the PR.
A fork PR gets no `id-token: write` and therefore no credentials; the diff step must be
conditional on `github.event.pull_request.head.repo.full_name == github.repository` rather
than failing.

Caching: `actions/setup-node`'s pnpm store cache plus `actions/cache` on
`node_modules/.cache/turbo`.

**Tests.** A deliberately failing lint, a stale `openapi.json`, and an oversized bundle each
fail the job in a scratch PR. Verify all three before merging the workflow.

---

### P0-31 — `deploy-dev.yml` and `scripts/smoke.mjs`

**Files.** `.github/workflows/deploy-dev.yml`, `scripts/smoke.mjs`.

**Approach.** The workflow in
[`../02-architecture/infrastructure.md#72-deploy-devyml--on-merge-to-main`](../02-architecture/infrastructure.md#72-deploy-devyml--on-merge-to-main).
Order matters: build the web export **before** `cdk deploy`, because `WebStack`'s
`BucketDeployment` consumes `apps/mobile/dist` as a CDK asset.

`scripts/smoke.mjs` hits `GET /v1/health`, asserts `200`, and asserts the returned `sha`
equals `process.env.GITHUB_SHA`. The authenticated half of the smoke test lands in Phase 1
when there is a user pool to mint a token from; leave a clearly marked `TODO(P1)` for it
rather than a silently skipped assertion.

`concurrency: { group: deploy-dev, cancel-in-progress: false }` is deliberate — cancelling
a CloudFormation deploy mid-flight leaves a stack in `UPDATE_IN_PROGRESS`.

**Tests.** Merge a no-op commit to `main` and watch a clean deploy plus a passing smoke run.

---

### P0-32 — `deploy-prod.yml` and the release tag flow

**Approach.** The workflow in
[`../02-architecture/infrastructure.md#73-deploy-prodyml--on-tag`](../02-architecture/infrastructure.md#73-deploy-prodyml--on-tag).
Deploy the prod stacks once in this phase so that the prod path is proven while it is
cheap: a prod `HttpApi` serving `/v1/health` and an empty prod table cost nothing. A first
prod deploy attempted for the first time in Phase 4, under time pressure, discovers every
certificate and DNS problem at the worst moment.

**Edge cases.** The `production` GitHub environment must exist with a required reviewer and
a 5-minute wait timer before the first tag is pushed, or the job runs unapproved.

**Tests.** Tag `v0.0.1`, approve, watch the prod deploy and prod smoke pass. Confirm
`https://api.ordinarydays.app/v1/health` returns `200`.

---

### P0-34 — GitHub environments, branch protection, signed commits

**Approach.** Create the `development` and `production` GitHub environments. On
`production`: required reviewer (yourself), 5-minute wait timer, and deployment branches
restricted to tags matching `v*`. Set `vars.AWS_ACCOUNT_ID` at the repository level.

Branch protection on `main` exactly as
[`../02-architecture/infrastructure.md#76-branch-protection-on-main`](../02-architecture/infrastructure.md#76-branch-protection-on-main):
PR required, up-to-date branches, conversation resolution, linear history, no force pushes,
signed commits, zero required approvals. The full required-check set is
`validate`, `integration`, `synth`, `depcruise`; only `validate` and `synth` exist in
Phase 0, so add the other two to the rule as their jobs land.

Set up commit signing locally (SSH signing is simplest) before enabling the rule, or you
will not be able to push.

---

### P0-35 — First deploy, SNS confirmation, cost allocation tags

**Approach.**

```bash
cd infra
pnpm exec cdk deploy od-account
pnpm exec cdk deploy 'od-*-dev' --require-approval never
```

Then, in order:

1. Confirm the SNS subscription email that lands in the alert inbox. An unconfirmed
   subscription means every alarm goes nowhere.
2. Billing and Cost Management → **Cost allocation tags** → activate `Project`, `Stage` and
   `Component`. They are **not retroactive** — they only appear in cost reports from the day
   they are activated, so do it on day one.
3. Confirm the bootstrap budget from P0-03 still exists alongside the `AccountStack`
   budgets; delete the bootstrap one only after the permanent ones have fired a test alert.

**Tests.** Trigger one alarm deliberately (set the `api-invocations-spike` threshold to 1,
deploy, call the API, confirm the email arrives, revert). An alarm nobody has ever seen fire
is an alarm you do not know works.

## Acceptance criteria

1. Billing and Cost Management shows the account plan as **Paid**, root has MFA enabled,
   and root has zero access keys.
2. A budget named `od-bootstrap-zero-spend` or its `AccountStack` successor exists, and a
   test alarm email has been received and archived.
3. `dig NS ordinarydays.app` returns AWS name servers, and the domain shows auto-renew on
   in the Route 53 console.
4. From a clean clone: `pnpm install && pnpm turbo run build lint typecheck test` exits 0
   in under 5 minutes on a warm cache.
5. `pnpm exec cdk synth 'od-*-dev'` emits templates for eight stacks with no errors.
6. `curl -s https://api.dev.ordinarydays.app/v1/health` returns HTTP 200 and a body whose
   `data.sha` equals the SHA of the commit currently on `main`.
7. `curl -s https://api.ordinarydays.app/v1/health` returns HTTP 200 (prod path proven).
8. `curl -I https://dev.ordinarydays.app` returns HTTP 200 with a `strict-transport-
   security` header, and `https://dev.ordinarydays.app/any/deep/path` returns the app shell
   rather than a 403.
9. `pnpm --filter @od/mobile ios` boots the simulator and the first screen displays the dev
   stage, the deployed SHA and a round-trip time.
10. `pnpm --filter @od/mobile web` serves the identical screen at `localhost:8081` from the
    same source file, with no platform-specific screen file.
11. Merging a no-op PR to `main` runs `validate` and `synth`, then deploys dev and passes
    `scripts/smoke.mjs`, with no AWS access key stored in GitHub (check: repository secrets
    contain no `AWS_ACCESS_KEY_ID`).
12. Pushing tag `v0.0.1` blocks on the `production` environment approval, then deploys prod
    and passes prod smoke.
13. `docker compose up -d && pnpm --filter @od/api ddb:create-table && pnpm --filter @od/api
    dev` serves `http://localhost:3000/v1/health` with `stage: "local"`.
14. `pnpm run gen:openapi && git diff --exit-code docs/generated/openapi.json` exits 0.
15. A synthesised template search for `AWS::EC2::NatGateway` returns nothing.
16. The AWS bill for the phase, excluding the domain registration, is under $1.

## Out of scope for this phase

| Do not build | Owned by |
| --- | --- |
| Cognito user pool, sign-up, sign-in, any auth middleware beyond a stub | Phase 1 (P1-01…P1-05) |
| Any DynamoDB repository, entity, or key construction beyond the health check's absence of one | Phase 1 |
| The Activity model, the Add screen, any creation form | Phase 1 |
| The recurrence engine — including "just a little of it" in `packages/shared` | Phase 2 |
| `GET /v1/agenda`, the Today screen, any of its four sections | Phase 2 |
| Lists, list items, the lists tab beyond an empty placeholder | Phase 3 |
| Attachments, presigned uploads, the media distribution's cache tuning | Phase 3 (P3-13…P3-15) |
| Push notifications, EventBridge Scheduler, the reminder Lambda | Phase 4 |
| EAS build credentials, App Store Connect, TestFlight | Phase 4 |
| The full Content Security Policy (ship report-only now) | Phase 4 (P4-02) |
| SES production access — dev stays in the sandbox | Phase 5 |
| DynamoDB Streams, the maintenance Lambda | Phase 6 |
| Any `/v1/capture/*` implementation; the `501` stubs themselves are Phase 1 | Phase 7 |
| A design system beyond the primitives needed to render one screen | Phase 1 (P1-29) |
| Provisioned concurrency, X-Ray, WAF, a VPC | Not in v1 at all |

## Risks and gotchas

| Risk | Signal | Mitigation |
| --- | --- | --- |
| The account is left on the Free Plan and closes at six months | Billing → Free tier shows plan "Free" | P0-01 step 9 is a hard gate. Re-verify at the end of the phase and again in Phase 2. |
| A NAT gateway or an idle always-on resource appears | The zero-spend budget fires | No Lambda is ever put in a VPC. The CDK assertion test in P0-28 fails the build on `AWS::EC2::NatGateway`. |
| The SNS alert subscription is never confirmed | Alarms exist, no email ever arrives | P0-35 deliberately fires one alarm and requires the email as evidence. |
| Metro resolves a stale copy of `@od/shared` | Editing `shared` does not hot-reload; type errors that disappear on restart | `watchFolders` + `disableHierarchicalLookup` in `metro.config.js`, exactly as specified. Do not "fix" it by hoisting node_modules. |
| React / React Native / RNW version drift between `apps/mobile` and `packages/ui` | Invalid-hook-call errors that look like a React bug | `syncpack` in CI, `npx expo install --fix` after any Expo-managed package change, `expo-doctor` in `ci.yml`. |
| The GSI projection is set to `ALL` "for now" | Nothing, until the agenda's cost and latency are wrong | P0-15's assertion test pins `ProjectionType: INCLUDE` and the non-key attribute list. Changing it later requires replacing the index. |
| The Lambda alias is skipped and the integration points at `$LATEST` | Nothing, until a bad prod deploy needs a 30-second rollback and there is none | P0-18 wires the alias on day one; the CDK assertion test asserts the integration URI references it. |
| CDK bootstrap qualifier mismatch | `cdk deploy` fails naming a missing SSM parameter | Set it in both the bootstrap command and `cdk.json` in the same commit. |
| The first prod deploy is deferred to Phase 4 | Certificate, DNS and approval-gate problems all surface at launch | P0-32 deploys prod in Phase 0, when the blast radius is a health endpoint. |
| Coverage gates are added after the recurrence engine and tuned down to fit it | 100% is quietly 82% | P0-26 configures the 100% path thresholds against a placeholder file before Phase 2 starts. |
</content>
</invoke>
