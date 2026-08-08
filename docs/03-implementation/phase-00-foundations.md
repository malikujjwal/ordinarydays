# Phase 0 — Foundations

## Goal

At the end of this phase a developer can clone the repository, run one command, and have the
API, the database and the app running on their laptop. The API answers
`GET /v1/health` from Hono on the Node adapter at `http://localhost:3000`. DynamoDB Local
holds a table whose key schema is generated from the same definition the CDK stack uses. The
Expo app renders the health response on the iOS simulator, in a browser, and on a physical
iPhone over the LAN through Expo Go — all from one source file. A five-workspace monorepo
builds, lints, type-checks, tests and dependency-checks in one command, and CI runs the same
set plus `cdk synth`.

**Nothing is deployed to AWS.** The account exists, is hardened and is budgeted, because
that takes minutes and is worth having in place before anyone is under pressure to deploy.
Eight CDK stacks are written and synthesise cleanly in CI, so the infrastructure cannot rot
while the product is built locally. The phase ends with a single throwaway `cdk deploy` of
one trivial stack, immediately destroyed, purely to prove the deploy path works. The first
lasting deployment is Phase 4.

## Prerequisites

| # | Item | Notes |
| --- | --- | --- |
| 1 | A macOS machine with Xcode and the iOS simulator | Required for the simulator target. |
| 2 | Node 22.x, `pnpm` 9.x, `git`, Docker Desktop | Node version pinned in `.nvmrc`; `corepack enable` for pnpm. Docker is required — DynamoDB Local is not optional in this phase. |
| 3 | A GitHub account and an empty repository `ordinarydays` | Private. Branch protection is configured in P0-30. |
| 4 | A physical iPhone with Expo Go installed, on the same LAN as the laptop | Required by P0-22. The LAN target is the one that catches `localhost` assumptions. |
| 5 | A payment method for AWS | Needed to open the account. This phase spends nothing beyond a temporary $1 authorisation hold. |
| 6 | An email address you will control in five years | A permanent personal address. There is no domain yet, so there is no `aws@ordinarydays.app` to forward from; the domain arrives in Phase 5. |
| 7 | A password manager and a TOTP app with a backed-up seed | Root MFA depends on it. |
| 8 | The canonical docs read in full | [`../02-architecture/infrastructure.md`](../02-architecture/infrastructure.md), [`../02-architecture/tech-stack.md`](../02-architecture/tech-stack.md), [`../04-conventions/repo-structure.md`](../04-conventions/repo-structure.md). |

An Apple Developer Program membership is **not** required in Phase 0, and no longer in
Phase 1 either. It is needed by Phase 4 (Sign in with Apple) and Phase 5 (TestFlight).
Enrolment can take several days, so start it during Phase 1 at the latest.

## Deliverables

- [ ] AWS account open, on the **Paid Plan**, root hardened, MFA on, no root access keys.
- [ ] A `$1` budget and a Cost Anomaly Detection monitor alerting by email. These are the
      only things that exist in the account at the end of the phase, besides IAM.
- [ ] An administrative identity through IAM Identity Center, with no long-lived access key
      on the laptop.
- [ ] Monorepo at `apps/mobile`, `services/api`, `packages/shared`, `packages/ui`, `infra`
      with `pnpm install && pnpm verify` green from a clean clone.
- [ ] TypeScript project references and path aliases wired, so a change in
      `packages/shared` type-checks through to both consumers without a build step.
- [ ] Eight CDK stacks **written** and synthesising with no AWS credentials:
      `AccountStack`, `DataStack`, `ApiStack`, `WebStack`, `ObservabilityStack`, and the
      three shells `DnsStack`, `AuthStack`, `SchedulerStack`.
- [ ] `docker compose up -d` plus one table-creation script gives a DynamoDB Local table
      whose key schema provably matches the synthesised `DataStack` table.
- [ ] `pnpm dev` starts DynamoDB Local, the API on `:3000` and Metro on `:8081`.
- [ ] `GET http://localhost:3000/v1/health` returns `200` with `stage: "local"`.
- [ ] The Expo app runs on the iOS simulator, in a browser, and on a physical iPhone over
      the LAN from one `app/(app)/index.tsx`, calls `/v1/health` through `@od/shared`, and
      shows the response.
- [ ] Biome, lefthook, dependency-cruiser and Vitest configured and enforcing.
- [ ] `ci.yml` running typecheck, lint, test, depcruise and `cdk synth` on every PR, with no
      AWS credentials involved.
- [ ] `docs/generated/openapi.json` generated and checked in; CI fails when stale.
- [ ] One throwaway stack deployed to dev and destroyed, proving credentials, bootstrap and
      the GitHub OIDC path end to end.

## Tasks

| ID | Title | Area | Depends on | Parallel-safe | Size |
| --- | --- | --- | --- | --- | --- |
| P0-01 | Create the AWS account and select the Paid Plan | infra | — | no | S |
| P0-02 | Harden the root account | infra | P0-01 | no | S |
| P0-03 | Create the zero-spend budget and anomaly monitor | infra | P0-02 | no | S |
| P0-04 | Create an administrative identity (IAM Identity Center) | infra | P0-02 | no | M |
| P0-05 | Initialise the repository and pnpm workspaces | repo | — | yes | M |
| P0-06 | Toolchain: Biome, lefthook, syncpack, tsconfig base and project references | ci | P0-05 | no | M |
| P0-07 | Scaffold `packages/shared` with the exports map and the table definition | shared | P0-06 | yes | M |
| P0-08 | Scaffold `packages/ui` | shared | P0-06 | yes | S |
| P0-09 | Scaffold the CDK app and `infra/lib/config.ts` | infra | P0-06 | yes | M |
| P0-10 | `NodeLambda` construct | infra | P0-09 | no | S |
| P0-11 | `AccountStack` | infra | P0-09 | yes | M |
| P0-12 | `DataStack` | infra | P0-09, P0-07 | yes | M |
| P0-13 | Scaffold `services/api`: Hono app and middleware chain | api | P0-07 | no | L |
| P0-14 | `GET /v1/health` | api | P0-13 | no | S |
| P0-15 | `ApiStack` | infra | P0-10, P0-12, P0-14 | no | L |
| P0-16 | `static-site` construct and `WebStack` | infra | P0-10, P0-12 | no | L |
| P0-17 | `ObservabilityStack` | infra | P0-15, P0-16 | no | M |
| P0-18 | Empty `DnsStack`, `AuthStack` and `SchedulerStack` shells | infra | P0-09 | yes | S |
| P0-19 | Scaffold `apps/mobile` (Expo Router, Metro workspace config) | mobile | P0-07, P0-08 | no | L |
| P0-20 | Shared HTTP client and the `health` endpoint function | shared | P0-07 | no | M |
| P0-21 | DynamoDB Local, the table script, and the local API server | api | P0-13, P0-12 | no | M |
| P0-22 | Health screen on simulator, web and a physical iPhone | mobile | P0-19, P0-20, P0-21 | no | M |
| P0-23 | `pnpm dev`: one command, and the clean-clone check | repo | P0-21, P0-22 | no | M |
| P0-24 | Vitest configuration and coverage gates | ci | P0-07, P0-13 | yes | M |
| P0-25 | OpenAPI generation harness | shared | P0-07 | yes | M |
| P0-26 | CDK assertion tests | infra | P0-12, P0-15, P0-16 | yes | M |
| P0-27 | dependency-cruiser rules and the three grep checks | ci | P0-13, P0-19 | yes | M |
| P0-28 | Bundle-size check script | ci | P0-13 | yes | S |
| P0-29 | `ci.yml` — typecheck, lint, test, depcruise, synth | ci | P0-24, P0-25, P0-26, P0-27, P0-28 | no | L |
| P0-30 | GitHub environments, branch protection, signed commits | ci | P0-29 | no | S |
| P0-31 | Deploy smoke test: bootstrap, one throwaway stack, destroy | infra | P0-04, P0-29 | no | M |

Tasks P0-08, P0-18 and P0-28 are mechanical and have no detail subsection: follow the
referenced canonical doc verbatim.

---

### P0-01 — Create the AWS account and select the Paid Plan

**What to build.** An AWS account that will still exist in six months. Nothing is deployed
into it during this phase, but it must be open and correct before Phase 4 needs it, and the
signup default closes the account.

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
3,000 message charges) also apply on both. What the Free Plan adds is credits with an expiry
attached to the account's life; what it costs is the account.

> **Decision:** open the account in Phase 0 even though nothing deploys until Phase 4. The
> six-month Free Plan clock starts at signup either way, the work is under an hour, and the
> alternative is opening an account, discovering an identity-verification or payment problem,
> and resolving it with AWS Support on the day the first deploy is due.

**Edge cases.** If signup is rejected for a payment reason, do not create a second account
with a different email — resolve it with AWS Support on the first one. Two accounts means two
free-tier clocks and a billing mess.

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
2. On the same page, confirm there are **no root access keys**. If one exists, delete it. A
   root access key has no legitimate use in this project.
3. Billing and Cost Management → **Account settings** → *IAM user and role access to Billing
   Information* → **Activate**. Without this an administrative IAM identity cannot read the
   bill, and every cost check requires signing in as root.
4. Set the alternate contacts (billing, operations, security) to an address you monitor.
5. Write down the five legitimate uses of root and never exceed them: closing the account,
   changing the support plan, changing the account email, changing the payment method, and
   enabling billing access (already done).

**Tests.** Manual. `aws iam get-account-summary` later shows `AccountMFAEnabled: 1`.

---

### P0-03 — Create the zero-spend budget and anomaly monitor

**What to build.** A tripwire that fires on the first cent, created before any resource
exists. `AccountStack` (P0-11) carries the permanent budgets, but it is not deployed in this
phase, so this console-created budget is the only live guard from now until Phase 4 — which
is exactly the window in which the P0-31 smoke deploy runs.

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
stacks in Phase 4. Do not treat the budget as a control.

**Tests.** Manual: the budget appears in the console and a test email arrives when you
confirm the subscription.

---

### P0-04 — Create an administrative identity

**What to build.** Short-lived administrative credentials on your laptop, with no long-lived
access key anywhere. Nothing in Phases 0 to 3 needs them except P0-31, but creating them now
is what makes P0-31 a twenty-minute task instead of a day.

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

6. `export AWS_PROFILE=od-admin` in your shell profile.

**Edge cases.** If Identity Center cannot be enabled (some account states block it), fall
back to one IAM user `od-admin` with `AdministratorAccess`, MFA enforced, and **no** access
key — use `aws sts get-session-token` with an MFA code to mint temporary credentials. Never
create a long-lived access key on a laptop; it is the most common cause of a compromised AWS
account.

**Tests.** `aws sts get-caller-identity` returns an assumed-role ARN containing
`AWSReservedSSO_AdministratorAccess`, not an IAM user ARN.

---

### P0-05 — Initialise the repository and pnpm workspaces

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
[`../02-architecture/tech-stack.md#1-repository-layout`](../02-architecture/tech-stack.md#1-repository-layout)
and expanded in
[`../04-conventions/repo-structure.md#5-workspace-configuration`](../04-conventions/repo-structure.md#5-workspace-configuration).
Package names are `@od/mobile`, `@od/api`, `@od/shared`, `@od/ui`, `@od/infra`. The root
`package.json` carries **scripts only** and no runtime dependencies; the script list is
[`../04-conventions/repo-structure.md#9-root-packagejson-scripts`](../04-conventions/repo-structure.md#9-root-packagejson-scripts)
verbatim, plus `seed:local` added by Phase 1.

`.npmrc`:

```
save-exact=true
strict-peer-dependencies=false
node-linker=isolated
```

`.nvmrc` contains `22`. Root `package.json#engines` pins `"node": ">=22 <23"`. The CDK Lambda
runtime is `NODEJS_22_X`. A CI check asserts all three agree (P0-29).

`.gitignore` must cover `node_modules`, `dist`, `.expo`, `cdk.out`, `.turbo`,
`.dynamodb-data`, `.env*` except `.env.example`, `*.p8`, `*.p12`, `*.mobileprovision`,
`coverage`, `.DS_Store`.

**Edge cases.** `node-linker=isolated` is pnpm's default and is what catches phantom
dependencies; do not switch to `hoisted` to fix a Metro resolution problem — fix the Metro
config instead (P0-19).

**Tests.** `pnpm install` from a clean clone succeeds. `pnpm -r exec node -e "0"` runs in all
five workspaces.

---

### P0-06 — Toolchain: Biome, lefthook, syncpack, tsconfig base and project references

**Files.** `biome.json`, `lefthook.yml`, `.syncpackrc`, `tsconfig.base.json`, and a
`tsconfig.json` per workspace extending it.

**Approach.** `tsconfig.base.json` is
[`../04-conventions/repo-structure.md#53-typescript-project-references`](../04-conventions/repo-structure.md#53-typescript-project-references)
verbatim — `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes:
true`, `moduleResolution: "Bundler"`, `target: "ES2022"` with `lib: ["ES2023", "DOM"]`,
`verbatimModuleSyntax: true`, `skipLibCheck: true`, and `composite: true`.

> **Corrected in P0-06:** this paragraph read `target: "ES2023"`. `repo-structure.md` §5.3
> says `ES2022` with an `ES2023` lib, `coding-standards.md` §1.1 names §5.3 as the authority
> on compiler options, and §5.3 is the complete config rather than a partial restatement of
> it. The lib is `ES2023` either way, so the only difference was whether a handful of ES2023
> syntax features downlevel.

**Project references and path aliases** are set up here, not retrofitted, exactly as
[`../04-conventions/repo-structure.md#53-typescript-project-references`](../04-conventions/repo-structure.md#53-typescript-project-references)
and §5.4 specify. `services/api` and `apps/mobile` each reference `packages/shared`;
`apps/mobile` also references `packages/ui`; `infra` references `packages/shared`.

**There are no `@od/*` entries in tsconfig `paths`.** Cross-package resolution is pnpm
workspace links plus each package's `exports` map (`tech-stack.md` §3.3), which Metro,
esbuild and `tsc` all understand. The only alias is `@/*` → `./src/*`, declared in
`apps/mobile/tsconfig.json` alone and mirrored in `metro.config.js` (P0-19), the Babel
module resolver, and the Vitest configs (P0-24). Two copies of that one-line table drifting
apart is the failure mode; a resolution test per consumer is the cheapest guard.

> **Corrected in P0-06:** this paragraph previously required `@od/shared/*`, `@od/ui` and
> an in-package `~/*` to be declared in `tsconfig.base.json`. `repo-structure.md` §5.4 says
> the opposite in as many words — "Do **not** add tsconfig `paths` entries for `@od/*`" —
> and gives the reason: a `paths` entry lets `tsc` resolve an import that Metro cannot,
> which is the exact failure the workspace links exist to prevent. §5.4 also names the
> in-package alias `@/*`, not `~/*`. The canonical doc wins on both counts.

`biome.json` at the root with per-workspace overrides. Enable `noUnusedVariables`,
`useExhaustiveDependencies`, `noExplicitAny`, and import sorting (`organizeImports`).
Formatter: 90-column line width, single quotes, trailing commas, 2-space indent.

`lefthook.yml` runs `biome check --write --staged` and `gitleaks git --staged` on
pre-commit, plus the commit-message lint on `commit-msg`.

> **Corrected in P0-06:** this read `gitleaks protect --staged`. `protect` is deprecated in
> gitleaks 8.x and no longer appears under `Available Commands`; `gitleaks git --staged` is
> the current spelling. The gitleaks job also runs unconditionally and fails the commit when
> the binary is absent. A skip-if-absent guard was written first and removed after testing:
> lefthook evaluated the condition in a shell that could not resolve `command -v`, so it
> reported "absent" with gitleaks installed and skipped the scan silently. A secret scanner
> that quietly does nothing is a worse artefact than one that is not installed.

`.syncpackrc` pins one version per dependency name across all workspaces. Divergent React or
React Native versions between `apps/mobile` and `packages/ui` produce hook-dispatcher errors
that cost a day to diagnose.

**Tests.** `pnpm exec biome ci .` passes on the empty tree. `pnpm exec syncpack
list-mismatches` reports none. `pnpm turbo run typecheck` builds the reference graph in the
right order. A deliberate `any` in a scratch file fails `biome ci`.

---

### P0-07 — Scaffold `packages/shared` with the exports map and the table definition

**Files.**

```
packages/shared/package.json          (exports map exactly as tech-stack.md §3.3)
packages/shared/tsconfig.json
packages/shared/src/index.ts
packages/shared/src/errors.ts
packages/shared/src/constants.ts
packages/shared/src/schemas/common.ts
packages/shared/src/types/index.ts
packages/shared/src/table/definition.ts
packages/shared/src/client/http.ts     (P0-20 fills this)
```

**Approach.** `errors.ts` exports the closed `ErrorCode` union from
[`../02-architecture/api-contract.md#1-shape`](../02-architecture/api-contract.md#1-shape)
plus `not_implemented` and `upgrade_required` from
[`../02-architecture/tech-stack.md#44-error-to-http-mapping`](../02-architecture/tech-stack.md#44-error-to-http-mapping),
and the `AppErrorBody` type. `constants.ts` exports `MAX_PARTICIPANTS = 50`,
`MAX_AGENDA_DAYS = 62`, `MAX_UPLOAD_BYTES = 10 * 1024 * 1024`, `MAX_LIST_ITEMS = 500`,
`MAX_TITLE_LEN = 200`, `MAX_NOTES_LEN = 4000`, `MAX_REMINDERS_PER_USER_PER_ACTIVITY = 3`,
`MAX_ACTIVE_SERIES = 200`, `OVERDUE_WINDOW_DAYS = 30`.

`schemas/common.ts` exports `isoDate`, `hhmm`, `ianaTimezone`, `cents`, `ulidId(prefix)`,
`cursor`. These are the primitives every other schema composes.

`table/definition.ts` is the single source of the table's key schema, as plain data with no
`aws-cdk-lib` and no `@aws-sdk` type, per
[`../04-conventions/repo-structure.md#3-dependency-direction`](../04-conventions/repo-structure.md#3-dependency-direction).
`DataStack` (P0-12) maps it onto CDK constructs; the local table script (P0-21) maps it onto
a `CreateTableCommand`; the integration harness maps it onto a per-file test table. Two
consumers, one definition, and no way for them to drift.

> **Decision:** the table definition lives at `packages/shared/src/table/definition.ts`, not
> at `infra/lib/table-schema.ts`. `repo-structure.md` §3 and `testing.md` §3.1 both name the
> shared path and the test harness already imports `@od/shared/table`; `infra` is allowed to
> import `@od/shared`, but `services/api` is not allowed to import `infra`, so the infra path
> cannot serve all three consumers. Correct the `projection: 'ALL'` in the illustrative
> snippet in `repo-structure.md` §3 to `INCLUDE` in the same PR — `data-model.md` §3.5 and
> `aws-services.md` §1.4 are the authority and they say `INCLUDE`.

Nothing in this package may import React, React Native, an AWS SDK client, or `process.env`.
The dependency-cruiser rules in P0-27 enforce it; add the unit test described in
[`../02-architecture/tech-stack.md#52-what-must-never-enter-shared`](../02-architecture/tech-stack.md#52-what-must-never-enter-shared)
as well, because it fails with a clearer message.

> **Decision:** resolve open question OQ-11 (`zod` v3 vs v4) in this task, not later. Check
> whether the `zod-to-openapi` package in the lockfile supports v4. If it does not, pin
> `zod@3` and record the pin with a one-line comment in `package.json`. Migrating schemas
> after Phase 1 touches every file in `src/schemas/`.
>
> **Closed in P0-07: v4, no pin needed.** The question's premise had expired.
> `@asteasolutions/zod-to-openapi@9` declares a peer dependency of `zod@^4.0.0`, so v3 is
> now the version that would need pinning, and `@hono/zod-validator@0.9` accepts either.
> `packages/shared` pins `zod@4.4.3`. Recorded in `decisions.md` OQ-11 and `tech-stack.md`
> §2.2.

**Tests.** A Vitest test importing every subpath export and asserting it resolves. A test
that greps the built output for `react` and `@aws-sdk` and fails on a hit.

---

### P0-09 — Scaffold the CDK app and `infra/lib/config.ts`

**Files.** The tree in
[`../02-architecture/infrastructure.md#1-cdk-app-layout`](../02-architecture/infrastructure.md#1-cdk-app-layout),
with `bin/ordinarydays.ts`, `lib/config.ts`, `cdk.json`, and one stack file per stack.

**Approach.** `lib/config.ts` is the Zod-validated `EnvConfig` given verbatim in
[`../02-architecture/infrastructure.md#22-context-driven-config`](../02-architecture/infrastructure.md#22-context-driven-config).
Fill in the `prod` object that the doc elides: `logRetentionDays: ONE_MONTH`,
`apiReservedConcurrency: 50`, `pointInTimeRecovery: true`, `removalPolicy: RETAIN`.

**The domain fields are optional and unset in Phase 0.** `domain`, `apiDomain`, `mediaDomain`
and `webOrigins` are typed `string | undefined` / `string[]`, and no stage sets them until
Phase 5 registers the domain. Every stack that consumes them branches once, at construction:
if `cfg.apiDomain` is undefined, `ApiStack` skips the custom domain, the certificate and the
alias record and the API is reachable only on its execute-api URL. That branch is what lets
the whole stack set synthesise before a domain exists.

`bin/ordinarydays.ts` instantiates `AccountStack` once and the per-stage stacks in a loop,
passing constructs as typed props — never `Fn::ImportValue` strings. Apply the five tags from
[`../02-architecture/infrastructure.md#24-tags`](../02-architecture/infrastructure.md#24-tags)
at the app level.

**Edge cases.**

- The stage is selected by stack name (`cdk deploy 'od-*-dev'`), not by a context flag. Do
  not add a `-c stage=` path; it is how dev config ends up in a prod stack.
- **Synth must not require credentials.** CI has no AWS role in this phase (P0-29), so no
  stack may call `HostedZone.fromLookup`, `Vpc.fromLookup`, or any other context lookup, and
  no stack may set `env: { account: process.env.CDK_DEFAULT_ACCOUNT }` in a way that makes
  it undefined-at-synth. Use environment-agnostic stacks in Phase 0 and let Phase 4 pin the
  environment when it first deploys. A lookup added carelessly turns a green CI job into one
  that only passes on the founder's laptop.

**Tests.** `pnpm exec cdk synth 'od-*-dev'` succeeds with `AWS_PROFILE` unset. A Vitest test
asserts `getConfig('prod').removalPolicy === RemovalPolicy.RETAIN` and that
`getConfig('dev').apiDomain` is `undefined`.

> **Corrected in P0-09: the template count.** This read "emits eight templates", which
> conflates three different numbers. There are **eight stack classes** (§1.1). `cdk.out`
> receives **fifteen** templates, because CDK synthesises the whole app — `od-account` plus
> seven stacks each for `dev` and `prod` — and a stack selector only chooses which to
> *display*. The selector `'od-*-dev'` matches **seven**; it does not match `od-account`,
> which is account-scoped and carries no stage. Assert the eight stack *names*, or the
> fifteen files, but not "eight templates".

---

### P0-10 — `NodeLambda` construct

**Files.** `infra/lib/constructs/node-lambda.ts`.

**Approach.** Exactly the construct in
[`../02-architecture/infrastructure.md#13-the-shared-lambda-construct`](../02-architecture/infrastructure.md#13-the-shared-lambda-construct).
Every Lambda in the project goes through it so runtime, architecture, bundling format, log
retention and log level cannot drift. Keep the `banner` — an ESM bundle has no `require` in
scope and some transitive dependencies still emit one.

**Edge cases.** `NodejsFunction` bundles with esbuild at synth time, which means `cdk synth`
in CI actually compiles the API. That is deliberate: it is the cheapest proof that the
deployed artifact still builds, and it is most of the value of running synth in a phase that
never deploys. `sourceMap` is on in dev and off in prod.

**Tests.** A CDK assertion test: the synthesised function has `Runtime: nodejs22.x`,
`Architectures: ["arm64"]`, `LoggingConfig.LogFormat: JSON`.

---

### P0-11 — `AccountStack`

**Files.** `infra/lib/stacks/account-stack.ts`.

**Approach.** The account-wide guards from
[`../02-architecture/infrastructure.md#34-budgets-before-anything-else`](../02-architecture/infrastructure.md#34-budgets-before-anything-else):
the $5 and $20 monthly cost budgets with email notifications, the Cost Anomaly Detection
monitor, and the GitHub OIDC provider plus the `od-github-deploy-{stage}` roles from
[`../02-architecture/infrastructure.md#38-github-oidc-role`](../02-architecture/infrastructure.md#38-github-oidc-role).

This stack is **written and synthesised only** in Phase 0. It is not deployed. The console
budget from P0-03 is the live guard until Phase 4, and P0-31 deploys the OIDC half of this
stack temporarily and then decides what to keep — see that task.

**Edge cases.** The OIDC role's trust policy must condition on
`token.actions.githubusercontent.com:sub` matching `repo:<owner>/ordinarydays:*` and on the
`aud` being `sts.amazonaws.com`. A trust policy with a wildcard `sub` lets any GitHub
repository in the world assume the role. Write the condition now, while the role is only a
synthesised template and getting it wrong costs nothing.

**Tests.** CDK assertion tests: two budgets exist with notification subscribers; the OIDC
role's trust policy contains a `StringLike` on `sub` scoped to this repository and a
`StringEquals` on `aud`; no policy statement grants `*` on `*`.

---

### P0-12 — `DataStack`

**Files.** `infra/lib/stacks/data-stack.ts`.

**Approach.** Table `od-main-{stage}`, `PAY_PER_REQUEST`, `pk`/`sk` string keys, TTL
attribute `ttl`, one GSI `GSI1` on `gsi1pk`/`gsi1sk` with projection type **`INCLUDE`**
limited to the `AgendaItem` fields, per
[`../02-architecture/aws-services.md#14-amazon-dynamodb`](../02-architecture/aws-services.md#14-amazon-dynamodb).
Streams are **off** in Phase 0 (Phase 7 turns them on). PITR and deletion protection follow
`cfg`. Media bucket `od-media-{stage}-{account}` with all four Block Public Access settings
on, SSE-S3, the three lifecycle rules, and CORS allowing `PUT` from `cfg.webOrigins` — which
is empty in Phase 0, so the CORS rule is only added when the list is non-empty.

Every key attribute, index name and projection is read from
`packages/shared/src/table/definition.ts` (P0-07). The stack maps that plain data onto CDK
constructs and adds nothing to it.

**Edge cases.** The GSI projection is `INCLUDE`, not `ALL`. Getting this wrong is invisible
until the agenda query's cost and latency are wrong at scale, and changing a GSI projection
requires replacing the index.

**Tests.** CDK assertion test on key schema, GSI projection type and non-key attributes, TTL
attribute name, and bucket public-access-block settings. A separate test (P0-21) asserts the
local table script produces the same key schema from the same definition.

---

### P0-13 — Scaffold `services/api`: Hono app and middleware chain

**Files.**

```
services/api/src/index.ts          handler = handle(app)
services/api/src/local.ts          @hono/node-server, dev only
services/api/src/app.ts            createApp(): middleware chain + route mounting
services/api/src/middleware/{requestId,logger,errorHandler,cors,securityHeaders,
                             bodyLimit,routeSplit}.ts
services/api/src/lib/{ddb,logger,errors,config}.ts
services/api/src/routes/health.ts
services/api/package.json  tsconfig.json  vitest.config.ts
```

**Approach.** Build the middleware chain in the exact order in
[`../02-architecture/tech-stack.md#42-middleware-chain-in-order`](../02-architecture/tech-stack.md#42-middleware-chain-in-order).
Phase 0 ships entries 1–7 and 12. Entries 8–10 (`identity`, `rateLimit`, `idempotency`) are
Phase 1; in Phase 0 they do not exist at all rather than existing as pass-throughs, and
`routeSplit` throws `not_found` for any `/v1/*` path other than `/v1/health`. A stubbed
pass-through that silently authorises everything is a worse artefact than a missing file.

`app.ts` exports `createApp(overrides?)` rather than a module-scope `app` constant. Both
`index.ts` and `local.ts` call it with no arguments. The override parameter is how Phase 1's
tests inject a stub identity provider without a bypass header existing in shipped code.

`lib/config.ts` parses `process.env` with Zod at module load and throws on a missing
variable. `lib/logger.ts` is a module-scope pino instance with the redaction paths from
[`../02-architecture/security-privacy.md`](../02-architecture/security-privacy.md) §4.
`lib/ddb.ts` creates one `DynamoDBDocumentClient` at module scope with
`removeUndefinedValues: true` and points at `DDB_ENDPOINT` when it is set — that is the only
local/deployed branch permitted in runtime code.

`lib/errors.ts` defines `AppError` and the `ErrorCode → HTTP status` table from
[`../02-architecture/tech-stack.md#44-error-to-http-mapping`](../02-architecture/tech-stack.md#44-error-to-http-mapping).
`errorHandler` translates `ZodError` to `validation_failed` with path-mapped `details[]`, and
the DynamoDB exception mappings, and guarantees that a `500` body is always the literal
string `"An unexpected error occurred."`.

**Edge cases.** CORS must answer `OPTIONS` before any identity decision. `bodyLimit` must run
before body parsing so a 5 MB body is never buffered into a JS object. The dev CORS origin
list must include the LAN origin used by P0-22 as well as `http://localhost:8081`.

**Tests.** Vitest against `createApp().fetch` directly, no AWS: an unknown path returns the
`404` envelope; a thrown `AppError` maps to the right status and body; `X-Request-Id` is
echoed; a 300 KB body returns `413`; `OPTIONS` from an allowed origin returns the CORS
headers and from a disallowed origin does not.

---

### P0-14 — `GET /v1/health`

**What to build.** The endpoint every smoke test and every alarm depends on, and the first
thing the app renders.

**Files.** `services/api/src/routes/health.ts`.

**Approach.** Unauthenticated, mounted before `routeSplit`'s private-route rule. Returns:

```json
{ "data": { "status": "ok", "sha": "…", "stage": "local", "coldStart": true },
  "meta": { "requestId": "req_…" } }
```

`sha` comes from a `GIT_SHA` environment variable, `process.env.GITHUB_SHA ?? 'local'`; CDK
sets it at deploy time from Phase 4 onward. `coldStart` is a module-scope boolean flipped to
`false` after the first invocation; under `local.ts` it is `true` only for the first request
after a `tsx watch` restart, which is a useful signal that the server reloaded. The handler
performs **no** I/O — no DynamoDB call — so it stays a pure liveness signal and cannot fail
because the table is throttled.

**Edge cases.** `Cache-Control: no-store` (the `securityHeaders` default) matters here: a
cached health response makes a reload look successful when it was not.

**Tests.** Unit: returns `200`, the envelope shape, and the SHA from the environment.

---

### P0-15 — `ApiStack`

**Files.** `infra/lib/stacks/api-stack.ts`.

**Approach.** A `NodeLambda` for `od-api-{stage}` with `entry` pointing at
`services/api/src/index.ts`, 1024 MB, 15 s timeout, reserved concurrency from `cfg`. Grant it
read/write on the `DataStack` table and its index, and `s3:PutObject`/`GetObject` on the
media bucket prefix — nothing wider.

Publish a version on every deploy and create the `live` alias, and point the
`HttpLambdaIntegration` at the **alias**, not `$LATEST`, per
[`../02-architecture/infrastructure.md#44-reverting-a-bad-lambda`](../02-architecture/infrastructure.md#44-reverting-a-bad-lambda).
Writing this now, in a stack that has never deployed, is free; retrofitting it after a bad
deploy in Phase 4 or 5 is not.

`HttpApi` (v2) with a single `$default` route, payload format 2.0, no authorizer.
Throttling: burst 100, rate 50 rps. Access logs to a CloudWatch log group with
`cfg.logRetentionDays`, JSON format. The custom domain, its certificate and its alias record
are added **only when `cfg.apiDomain` is set**, which no stage does until Phase 5.

Environment variables: `TABLE_NAME`, `MEDIA_BUCKET`, `STAGE`, `LOG_LEVEL`, `GIT_SHA`,
`WEB_ORIGINS`, and `AUTH_MODE` (Phase 1 introduces it; the stack sets it to `cognito` for
every deployed stage and never to `local` — see P1-02). Identifiers only, nothing secret.

**Edge cases.** When Phase 5 does add the custom domain, the A record and the certificate
must both exist before the mapping, and CDK orders this correctly only if the certificate is
passed as a construct. Passing an ARN string produces a race on first deploy. Write the
conditional branch that way now.

**Tests.** CDK assertion tests: exactly one route (`$default`), the integration URI
references the alias, `PayloadFormatVersion: 2.0`, throttle settings present, log group
retention matches `cfg`, and — with `apiDomain` unset — no `AWS::ApiGatewayV2::DomainName`
resource is emitted.

---

### P0-16 — `static-site` construct and `WebStack`

**Files.** `infra/lib/constructs/static-site.ts`, `infra/lib/stacks/web-stack.ts`,
`infra/lib/functions/uri-rewrite.js` (CloudFront Function source).

**Approach.** Private S3 bucket `od-web-{stage}-{account}` with versioning on and all public
access blocked; a CloudFront distribution with Origin Access Control (not OAI);
`PRICE_CLASS_100`; HTTP/2 and HTTP/3; `REDIRECT_TO_HTTPS`; TLS 1.2 minimum; default root
object `index.html`. The edge certificate and the alternate domain name are added only when
`cfg.domain` is set; until Phase 5 the distribution is reachable on its
`*.cloudfront.net` name.

Two cache policies: `/_expo/static/*` gets `max-age=31536000, immutable`; `*.html` gets
`max-age=0, must-revalidate`.

The viewer-request CloudFront Function rewrites extensionless paths to `path/index.html` so
Expo Router's static export resolves, and rewrites unmatched dynamic segments
(`/invite/<token>`) to the route's pre-rendered shell. CloudFront Functions, not Lambda@Edge
— see
[`../02-architecture/aws-services.md#16-amazon-cloudfront`](../02-architecture/aws-services.md#16-amazon-cloudfront).

A response-headers policy with HSTS, `X-Content-Type-Options`, `Referrer-Policy` and a
`Permissions-Policy` denying camera, microphone and geolocation. The full Content Security
Policy is Phase 5 (P5-06); write a report-only CSP now.

Also create the **media** distribution here over the `DataStack` media bucket, so every
distribution and cache policy lives in one file.

**Edge cases.** `BucketDeployment` fails at synth if `apps/mobile/dist` does not exist, and
in Phase 0 it usually does not. Guard it: skip the deployment construct when the directory is
absent. That guard is what keeps `cdk synth` green in CI without building the web export
first, and it must survive into Phase 4, where CI does build the export before deploying.

**Tests.** CDK assertion tests on OAC presence, the absence of any public bucket policy, the
two cache policies, the function association, and — with `cfg.domain` unset — that the
distribution has no `Aliases` and no `ViewerCertificate` referencing ACM.

---

### P0-17 — `ObservabilityStack`

**Files.** `infra/lib/stacks/observability-stack.ts`, `infra/lib/constructs/alarm.ts`,
`infra/observability/queries/*.txt`.

**Approach.** One SNS topic `od-alerts-{stage}` with an email subscription to
`cfg.alertEmail`. The alarms from
[`../02-architecture/aws-services.md#112-amazon-cloudwatch-logs-metrics-alarms`](../02-architecture/aws-services.md#112-amazon-cloudwatch-logs-metrics-alarms)
that watch resources this phase writes: `api-5xx`, `api-errors`, `api-throttles`,
`api-invocations-spike`, `api-p95-latency` and `ddb-throttles`. `ses-bounce-rate` and
`reminder-errors` arrive with the resources they watch (Phases 5 and 6). One CloudWatch
dashboard. Check in the Log Insights queries for the common investigations.

Publish **no custom metrics** — the always-free allowance is 10 and every one beyond is
$0.30/month. Business counters come from structured logs via Log Insights.

**Edge cases.** An unconfirmed SNS email subscription means every alarm goes nowhere,
silently. Nothing is deployed in this phase, so nothing can be confirmed; **Phase 4 owns
confirming the subscription and firing one alarm deliberately as evidence.** Record that
explicitly in the stack's header comment so it is not assumed to have happened.

**Tests.** CDK assertion test counting alarms and asserting each has an SNS action.

---

### P0-19 — Scaffold `apps/mobile`

**Files.**

```
apps/mobile/app/_layout.tsx           providers: Query, theme, gesture root
apps/mobile/app/(app)/_layout.tsx
apps/mobile/app/(app)/index.tsx
apps/mobile/app/+not-found.tsx
apps/mobile/app.config.ts
apps/mobile/metro.config.js
apps/mobile/eas.json                  profiles only; EAS project linked in Phase 5
apps/mobile/src/lib/queryClient.ts
apps/mobile/src/lib/apiClient.ts
apps/mobile/tsconfig.json  package.json
```

**Approach.** `npx create-expo-app` with the SDK 54 blank-TypeScript template, then delete
its scaffolding down to the tree above and wire Expo Router. `app.config.ts` is the
profile-driven config in
[`../02-architecture/infrastructure.md#64-pointing-the-client-at-local--dev--prod`](../02-architecture/infrastructure.md#64-pointing-the-client-at-local--dev--prod),
including the distinct bundle identifiers and URL schemes per profile and
`web.output: "static"`. In Phase 0 only the `local` profile resolves to a working
`apiBaseUrl`; the `dev` and `prod` entries stay in the table pointing at the hostnames Phase 4
and Phase 5 will create, so the shape does not change later.

The `local` entry must resolve to the LAN IP, not `localhost`, when Metro is serving a
physical device. Derive it from `Constants.expoConfig.hostUri` (the host Metro is already
serving from) with a `localhost` fallback, rather than hard-coding an address that changes
every time the laptop joins a different network.

`metro.config.js` is the workspace-aware config in
[`../02-architecture/tech-stack.md#33-consuming-the-shared-package`](../02-architecture/tech-stack.md#33-consuming-the-shared-package)
verbatim. Without `watchFolders` and `disableHierarchicalLookup`, edits to `packages/shared`
will not hot-reload and will occasionally resolve to a stale copy.

`queryClient.ts` uses the defaults in the same doc §3.4 (60 s `staleTime`, 7-day `gcTime`,
`networkMode: 'offlineFirst'`). Persistence is Phase 2 (P2-33); Phase 0 ships the plain
client.

**Edge cases.**

- React 19 plus React Native Web 0.20 requires that `react`, `react-dom`, `react-native` and
  `react-native-web` versions match exactly across `apps/mobile` and `packages/ui`. `syncpack`
  enforces it; run `npx expo install --fix` after any change and `npx expo-doctor` before
  committing.
- Everything in Phase 0 runs inside **Expo Go**, which carries a fixed set of native modules.
  The first dependency needing a config plugin or a custom native module — `expo-secure-store`
  is fine, `expo-apple-authentication` is not — forces a development build. That happens in
  Phase 4. Keep the `development` profile in `eas.json` now so the switch is a build command,
  not a configuration project.

**Tests.** `pnpm --filter @od/mobile exec expo export --platform web` produces `dist/`.
`npx expo-doctor` passes.

---

### P0-20 — Shared HTTP client and the `health` endpoint function

**Files.** `packages/shared/src/client/http.ts`,
`packages/shared/src/client/endpoints/health.ts`, `packages/shared/src/client/index.ts`,
`packages/shared/src/schemas/health.ts`.

**Approach.** `http.ts` is a `fetch` wrapper taking an injected `fetch` implementation, a base
URL, and a token provider. It sets `X-Request-Id`, `X-Client-Timezone` and `X-Client-Version`
on every request, parses the `{ data, meta }` / `{ error }` envelope, maps error bodies onto a
typed `ApiError` carrying the `ErrorCode`, and retries idempotent `GET`s up to three times on
network failure and `5xx` with jittered backoff. It never retries a `POST` without an
`Idempotency-Key`.

The token provider is an **interface parameter from the first commit**, not an optional
extra. Phase 0 passes a provider that yields nothing and the client adds no `Authorization`
header; Phase 1 names the interface `AuthTokenProvider` and ships `NullTokenProvider`
(P1-19); Phase 4 swaps in the Cognito implementation. The header-injection code path is
written once, here, and never edited again.

Response validation: `safeParse` against the endpoint's Zod schema. In `dev` and `test`
builds a parse failure throws; in production it logs a warning and returns the raw body — a
server that added a field must not break a shipped app.

**Edge cases.** No `process.env` reads in this package. Configuration arrives as constructor
arguments from `apps/mobile/src/lib/apiClient.ts`, which is where Expo's `extra` is read.

**Tests.** Vitest with a stubbed `fetch`: envelope parsing, error mapping for each
`ErrorCode`, retry counts and backoff on `500` and on a network throw, no retry on `400`,
header injection, a token provider yielding nothing produces **no** `Authorization` header at
all (not an empty one), and the dev-throws / prod-warns response-validation split.

---

### P0-21 — DynamoDB Local, the table script, and the local API server

**Files.** `docker-compose.yml` (root), `services/api/scripts/create-local-table.ts`,
`services/api/src/local.ts`, `services/api/.env.example`, `services/api/.env.local`
(git-ignored).

**Approach.** `docker-compose.yml` takes the two DynamoDB services from
[`../02-architecture/infrastructure.md#61-dynamodb-local-and-minio`](../02-architecture/infrastructure.md#61-dynamodb-local-and-minio),
including `dynamodb-admin` on `:8001` — being able to look at the rows is worth one container.
The `minio` service in that block belongs to Phase 3 (P3-21) and is not added here.
`create-local-table.ts` imports `@od/shared/table` and maps it onto a `CreateTableCommand`, so
the local table and `DataStack` share one definition. It is idempotent: an existing table with
a matching schema is a no-op, an existing table with a *different* schema is deleted and
recreated with a printed warning, because a laptop table is disposable.

```bash
docker compose up -d
pnpm --filter @od/api ddb:create-table
pnpm --filter @od/api dev            # tsx watch src/local.ts, port 3000
```

Local environment (`services/api/.env.local`), with the Cognito variables that
`infrastructure.md` §6.2 lists **omitted** — there is no user pool until Phase 4:

```
STAGE=local
LOG_LEVEL=debug
TABLE_NAME=od-main-local
DDB_ENDPOINT=http://localhost:8000
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=local
AWS_SECRET_ACCESS_KEY=localsecret
MEDIA_BUCKET=od-media-local
```

`.env.example` documents every variable with placeholder values and is the only `.env*` file
in git. Phase 1 adds `AUTH_MODE=local` to both files.

**Edge cases.**

- DynamoDB Local requires credentials to be *present*, not valid. The literal strings above
  are correct; omitting them produces a confusing `CredentialsProviderError` rather than a
  connection error.
- The `./.dynamodb-data` volume persists across `docker compose down`. That is wanted — the
  seeded data from Phase 1 survives a restart — but it also means a stale table can outlive a
  schema change. `pnpm --filter @od/api ddb:create-table` is the reset button and must stay
  cheap enough to run without thinking.

**Tests.** An integration test that creates the table against DynamoDB Local, round-trips an
item, and asserts the local table's `KeySchema`, `AttributeDefinitions` and
`GlobalSecondaryIndexes` equal the synthesised `DataStack` table's, attribute for attribute.
This is the test that makes "the local database is the real schema" a fact rather than a
hope, and it must run in CI (which has Docker) not only on the laptop.

---

### P0-22 — Health screen on simulator, web and a physical iPhone

**What to build.** The proof that the whole local loop closes on all three targets.

**Files.** `apps/mobile/app/(app)/index.tsx`, `apps/mobile/src/lib/apiClient.ts`,
`apps/mobile/src/features/health/hooks/useHealth.ts`.

**Approach.** One screen, one `useQuery` in a feature hook calling `api.getHealth()`. Render
the stage, the SHA, the resolved API base URL and the round-trip time. `apiClient.ts`
constructs the shared client from `Constants.expoConfig.extra.apiBaseUrl`. The layering rule
from
[`../02-architecture/tech-stack.md#32-layering`](../02-architecture/tech-stack.md#32-layering)
applies from the first screen: the route calls a feature hook, the hook is the only place
`useQuery` appears, and the hook calls the shared client. A `fetch` call in a component is a
review rejection even here.

Rendering the resolved base URL on screen is not decoration. It is what turns "the device
shows a spinner forever" into "the device is calling `http://localhost:3000`" in one glance.

**Verification, all three targets:**

```bash
pnpm --filter @od/mobile ios          # simulator; localhost:3000 reaches the host directly
pnpm --filter @od/mobile web          # localhost:8081 in a browser
pnpm --filter @od/mobile start        # scan the QR code with Expo Go on the iPhone
```

**Edge cases.**

- On a physical device `localhost` is the phone. The base URL must resolve to the laptop's
  LAN IP, which P0-19 derives from `hostUri`.
- iOS blocks cleartext HTTP by default. Add an ATS exception for the LAN address range in the
  **dev/local** app config only, never in the production config. Expo Go applies the
  exception from the manifest; a development build in Phase 4 needs it in `app.config.ts`
  under `ios.infoPlist`.
- The laptop firewall must allow inbound connections on 3000 and 8081. macOS prompts once;
  denying that prompt is the single most common cause of "it works on the simulator and not
  on the phone".
- Corporate and guest Wi-Fi networks often isolate clients from each other. If the device
  cannot reach the laptop at all, test on a phone hotspot before debugging the code.

**Tests.** A Playwright test against the exported web build asserting the health element is
present and non-empty (wired in P0-29). The physical-device leg is verified manually and
recorded, with a screenshot, in the phase's completion notes — there is no way to automate it
and no substitute for doing it.

---

### P0-23 — `pnpm dev`: one command, and the clean-clone check

**What to build.** The goal of the phase, made into a single command.

**Files.** Root `package.json` scripts, `scripts/dev-preflight.mjs`, `README.md` quickstart.

**Approach.** `pnpm dev` runs `turbo run dev --parallel`, which starts the API and Metro. The
missing piece is the database, and `docker compose up -d` is exactly the step a new developer
forgets. Two acceptable shapes:

```json
{ "scripts": { "dev": "node scripts/dev-preflight.mjs && turbo run dev --parallel" } }
```

`dev-preflight.mjs` checks, in order, and fixes or fails with a one-line instruction:

| Check | On failure |
| --- | --- |
| Node version matches `.nvmrc` | Fail, printing the expected and actual versions |
| Docker daemon is reachable | Fail with `Start Docker Desktop and re-run` |
| DynamoDB Local answers on `:8000` | Run `docker compose up -d` and wait for it |
| The table `od-main-local` exists | Run the P0-21 create-table script |
| `services/api/.env.local` exists | Copy `.env.example` and print what was copied |

Every check is idempotent and the whole preflight is under two seconds when everything is
already up.

**Edge cases.** The preflight must never *silently* fix something a developer would want to
know about. Printing one line per action taken is the difference between a helpful script and
a magic one.

**Tests.** The real test is the clean-clone check, and it is a phase acceptance criterion:
from a fresh `git clone` on a machine with only Node, pnpm and Docker installed,
`pnpm install && pnpm dev` reaches a working health screen with no other command and no
manual editing of any file. Run it in a throwaway directory, timed, before calling the phase
done. A second developer, or the same developer six weeks later, gets exactly this experience
and nothing more.

---

### P0-24 — Vitest configuration and coverage gates

**Files.** `vitest.workspace.ts` at the root, `vitest.config.ts` per workspace,
`packages/shared/vitest.config.ts` carrying the coverage thresholds.

**Approach.** `@vitest/coverage-v8`. Global thresholds: 70% statements repo-wide as a floor
that rises with each phase, per
[`definition-of-done.md`](definition-of-done.md) §3. Path-scoped thresholds at **100%
statements and branches** for `packages/shared/src/recurrence/**` and
`packages/shared/src/money/**`. Those directories do not exist yet; configure the thresholds
now against a placeholder file so the gate is live the moment the first line is written,
rather than being added after the code and tuned down to fit it.

Integration tests are a separate Vitest project (`test:int`) so that `pnpm test` runs with no
Docker requirement and `pnpm test:int` requires it. CI runs both.

**Tests.** Meta: a deliberately uncovered branch in the placeholder recurrence file fails
`pnpm turbo run test -- --coverage`.

---

### P0-25 — OpenAPI generation harness

**Files.** `packages/shared/src/openapi.ts`, root script `gen:openapi`, output
`docs/generated/openapi.json`.

**Approach.** Register each Zod schema with `zod-to-openapi` as it is written and emit the
document to `docs/generated/openapi.json`, which is **checked in**. In Phase 0 only
`/v1/health` is registered. CI regenerates and fails on a diff, so the spec cannot drift from
the schemas. This is how a new agent discovers the API without reading every handler.

**Edge cases.** The generated document has no `servers` block in Phase 0, because there is no
deployed URL. Emit `servers: [{ url: "http://localhost:3000" }]` rather than omitting the key
entirely, so Phase 4 adds an entry instead of introducing a field and producing a large diff.

**Tests.** `pnpm run gen:openapi && git diff --exit-code docs/generated/openapi.json` passes;
adding a field to a schema without regenerating fails it.

---

### P0-26 — CDK assertion tests

**Files.** `infra/test/*.test.ts` using `aws-cdk-lib/assertions` under Vitest.

**Approach.** One test file per stack. In a phase where nothing is deployed, these tests are
the *only* thing standing between a written stack and a broken one, so they carry more weight
here than they will later. Assert the properties that would be expensive to get wrong and
invisible if they were: table key schema and GSI projection type, bucket public access blocks,
the API integration pointing at the alias, Lambda runtime and architecture, log retention
values per stage, alarm count and SNS actions, the OIDC trust policy condition,
`RemovalPolicy.RETAIN` on prod stateful resources, and the absence of any
`AWS::EC2::NatGateway` anywhere in any synthesised template.

Add two assertions specific to the local-first shape: with the domain fields unset, no stack
emits a `AWS::CertificateManager::Certificate`, an `AWS::Route53::RecordSet`, or an API
Gateway domain name; and every stack synthesises with no environment configured.

**Edge cases.** Snapshot tests over whole templates are brittle and get regenerated
thoughtlessly. Assert named properties, not snapshots.

**Tests.** The tests are the deliverable. They run in `ci.yml`'s `validate` job.

---

### P0-27 — dependency-cruiser rules and the three grep checks

**Files.** `.dependency-cruiser.cjs`, root script `depcruise`.

**Approach.** The rule set in
[`../04-conventions/repo-structure.md#4-how-the-rules-are-enforced`](../04-conventions/repo-structure.md#4-how-the-rules-are-enforced)
verbatim, plus the three grep checks in the same section as separate CI steps so a failure
names the rule that broke.

Configure it in Phase 0, when most rules have nothing to catch. A dependency rule added after
the violating import exists is a refactor; added before, it is a two-second CI step that has
never once been argued with. `shared-is-a-leaf`, `no-react-in-shared`,
`no-aws-sdk-in-shared-or-ui` and `no-server-code-in-client` all have real subjects from this
phase; `ddb-only-in-repositories` and `layers-are-one-way` have none until Phase 1 and are
configured anyway.

**Edge cases.** `no-orphans` is `warn`, not `error`, and stays that way — config files and
`.d.ts` shims trip it constantly and a warning that is always present is a rule nobody reads.
If it becomes noise, tighten `pathNot` rather than deleting the rule.

**Tests.** Meta: add a scratch file importing `@aws-sdk/client-dynamodb` from
`packages/shared`, confirm `pnpm depcruise` fails naming `no-aws-sdk-in-shared-or-ui`, then
delete it. Do the same for one layering rule. A rule that has never been seen to fail is not
known to work.

---

### P0-29 — `ci.yml` — typecheck, lint, test, depcruise, synth

**Files.** `.github/workflows/ci.yml`, `scripts/check-bundle-size.mjs`,
`scripts/check-node-versions.mjs`.

**Approach.** The workflow in
[`../02-architecture/infrastructure.md#71-ciyml--validation-on-every-pr`](../02-architecture/infrastructure.md#71-ciyml--validation-on-every-pr),
with one deliberate change: **the `synth` job takes no AWS credentials.** It runs
`pnpm --filter @od/infra exec cdk synth 'od-*-dev'` instead of `cdk diff`, and has no
`id-token: write` permission and no `configure-aws-credentials` step. There is nothing
deployed to diff against, and a job that needs credentials is a job that cannot run on a fork
PR. Phase 4 adds the credentialled `cdk diff` step back and re-adds the permission.

Jobs:

| Job | Steps |
| --- | --- |
| `validate` | install, `biome ci .`, `check-node-versions.mjs`, `turbo run typecheck`, `turbo run test -- --coverage`, `gen:openapi` + `git diff --exit-code`, build the API bundle + `check-bundle-size.mjs`, `expo-doctor`, gitleaks, upload coverage |
| `depcruise` | install, `pnpm depcruise`, then the three grep checks as separate steps |
| `integration` | `docker compose up -d`, wait for `:8000`, `pnpm test:int` |
| `synth` | install, `cdk synth 'od-*-dev'`, no credentials |

Caching: `actions/setup-node`'s pnpm store cache plus `actions/cache` on
`node_modules/.cache/turbo`.

**Edge cases.** `cdk synth` bundles the API with esbuild (P0-10), so the `synth` job is also a
build check and will fail on a type-level error that `tsc` allowed through — usually an import
of something that does not exist at runtime. Do not "speed it up" by stubbing the bundling;
that is most of the job's value in a phase with no deploy.

**Tests.** A deliberately failing lint, a stale `openapi.json`, an oversized bundle, a
forbidden import and a broken stack each fail the job in a scratch PR. Verify all five before
merging the workflow.

---

### P0-30 — GitHub environments, branch protection, signed commits

**Approach.** Create the `development` and `production` GitHub environments now, even though
nothing deploys to either until Phase 4. On `production`: required reviewer (yourself),
5-minute wait timer, and deployment branches restricted to tags matching `v*`. Set
`vars.AWS_ACCOUNT_ID` at the repository level.

Branch protection on `main` exactly as
[`../02-architecture/infrastructure.md#76-branch-protection-on-main`](../02-architecture/infrastructure.md#76-branch-protection-on-main):
PR required, up-to-date branches, conversation resolution, linear history, no force pushes,
signed commits, zero required approvals. The required-check set is the four jobs from P0-29:
`validate`, `depcruise`, `integration`, `synth`. All four exist in Phase 0, so all four are
required from the first PR.

Set up commit signing locally (SSH signing is simplest) before enabling the rule, or you will
not be able to push.

---

### P0-31 — Deploy smoke test: bootstrap, one throwaway stack, destroy

**What to build.** A single end-to-end proof that this repository can deploy to this AWS
account through GitHub Actions, followed by deleting everything it made. This is a test of
the pipeline, not the start of an environment.

**Files.** `infra/lib/stacks/smoke-stack.ts`, `.github/workflows/deploy-smoke.yml`.

**Approach.**

1. Bootstrap CDK from the laptop:

   ```bash
   cd infra
   export CDK_DEFAULT_ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
   export CDK_DEFAULT_REGION=us-east-1

   pnpm exec cdk bootstrap "aws://${CDK_DEFAULT_ACCOUNT}/us-east-1" \
     --qualifier odays \
     --cloudformation-execution-policies arn:aws:iam::aws:policy/AdministratorAccess
   ```

   The qualifier must also appear in `infra/cdk.json` under
   `"@aws-cdk/core:bootstrapQualifier": "odays"`, exactly as in
   [`../02-architecture/infrastructure.md#36-bootstrap-cdk`](../02-architecture/infrastructure.md#36-bootstrap-cdk).

2. Deploy only the OIDC provider and the `od-github-deploy-dev` role from `AccountStack`
   (P0-11), scoped so this is the only part of that stack that lands.
3. `SmokeStack` contains exactly one resource: an `AWS::SSM::Parameter` with a fixed name and
   the value `ok`. It costs nothing, deploys in under a minute, and deletes cleanly.
4. `deploy-smoke.yml` is `workflow_dispatch` only. It assumes `od-github-deploy-dev` through
   OIDC, runs `cdk deploy od-smoke-dev --require-approval never`, reads the parameter back
   with the CLI to prove the deploy actually took effect, then runs
   `cdk destroy od-smoke-dev --force` and asserts the stack is gone.
5. Run it. Then confirm in the console that `od-smoke-dev` no longer exists and the SSM
   parameter is gone.

**Why this belongs at the end of Phase 0.** Five things have to be simultaneously correct
before any `cdk deploy` from CI works: the bootstrap stack exists with the right qualifier;
the CDK execution policy is broad enough; the OIDC provider's thumbprint and audience are
right; the role's trust policy `sub` condition matches this repository and ref; and the
workflow requests `id-token: write`. Each failure mode produces a different and not
especially clear error. Discovering all five for the first time in Phase 4 — in the same
change that introduces a Cognito user pool, a real table, and a custom domain — means
debugging two unrelated problems at once and not knowing which is which. Twenty minutes here
buys that separation.

> **Decision:** what survives Phase 0 inside AWS is exactly: the account, the console budget
> and anomaly monitor, IAM Identity Center and its permission set, the CDK bootstrap stack
> (`CDKToolkit`: an empty S3 bucket, an unused ECR repository, five roles), and the GitHub
> OIDC provider with one deploy role. Every one of those is $0/month at rest and every one is
> needed by Phase 4. `SmokeStack` and anything else is destroyed. The bootstrap is deliberately
> left in place rather than being torn down and repeated: `cdk bootstrap` is idempotent and
> re-bootstrapping with a *different* qualifier creates a second, unused set of roles and
> buckets, which is the failure this task exists to prevent. **Phase 4 verifies the bootstrap
> rather than repeating it**, and owns it outright if this task was skipped.

**Edge cases.**

- Do not deploy `DataStack` "since it is cheap". An empty on-demand table is nearly free, but
  it is a stateful resource with a lifecycle, and once it exists somebody will point local
  development at it. Local development uses DynamoDB Local for all of Phases 0 to 3, without
  exception.
- `cdk destroy` does not remove the bootstrap bucket's contents. It does not need to; the
  assets are a few hundred kilobytes and the bucket has a lifecycle rule.
- If the account is fewer than 24 hours old, some API calls are rate-limited or briefly
  unavailable. A failure here that looks like a permissions problem may simply be a new
  account; retry before rewriting the trust policy.

**Tests.** The workflow run is the test, and its log is the evidence. Record the run URL in
the phase completion notes. Additionally assert in the workflow, not by eye, that
`aws cloudformation describe-stacks --stack-name od-smoke-dev` fails after the destroy step —
a destroy that silently no-ops is exactly the failure this task must not miss.

## Acceptance criteria

1. Billing and Cost Management shows the account plan as **Paid**, root has MFA enabled, and
   root has zero access keys.
2. A budget named `od-bootstrap-zero-spend` exists and a test alert email has been received
   and archived.
3. `aws sts get-caller-identity` from the laptop returns an assumed-role ARN, and the account
   contains no IAM user with an access key.
4. From a clean clone on a machine with only Node, pnpm and Docker:
   `pnpm install && pnpm dev` reaches a working health screen with no other command and no
   manual file editing. Timed and recorded.
5. `pnpm verify` (lint, typecheck, test, depcruise) exits 0 in under 5 minutes on a warm
   cache.
6. `pnpm exec cdk synth 'od-*-dev'` emits templates for eight stacks with `AWS_PROFILE` unset
   and no network access.
7. `curl -s http://localhost:3000/v1/health` returns HTTP 200 with `data.stage === "local"`.
8. `pnpm --filter @od/mobile ios` boots the simulator and the first screen displays the
   stage, the SHA, the resolved base URL and a round-trip time.
9. `pnpm --filter @od/mobile web` serves the identical screen at `localhost:8081` from the
   same source file, with no platform-specific screen file.
10. The same screen loads on a physical iPhone through Expo Go over the LAN and shows the
    laptop's LAN address as the resolved base URL. Verified with a screenshot.
11. The integration test asserting the DynamoDB Local table's key schema equals the
    synthesised `DataStack` table's passes in CI, not only locally.
12. `pnpm run gen:openapi && git diff --exit-code docs/generated/openapi.json` exits 0.
13. A scratch PR containing a forbidden import fails `depcruise` naming the specific rule.
14. A synthesised template search for `AWS::EC2::NatGateway` returns nothing.
15. The `deploy-smoke.yml` run succeeded and `od-smoke-dev` no longer exists. Run URL
    recorded.
16. Exactly two CloudFormation stacks exist: `CDKToolkit`, and the deliberately partial
    `AccountStack` holding only the GitHub OIDC provider and the `od-github-deploy-dev`
    role retained by P0-31. Outside CloudFormation, the console budget and anomaly monitor
    from P0-03 remain. Nothing else belonging to this project exists — no `od-smoke-dev`,
    and no DynamoDB table, Lambda function, API, S3 bucket or CloudFront distribution.
17. The AWS bill for the phase is $0.00.

## Out of scope for this phase

| Do not build | Owned by |
| --- | --- |
| `cdk bootstrap` as the entry to a standing environment; any lasting deployed resource; `deploy-dev.yml`; `nightly.yml`; the SNS subscription confirmation and the first deliberate alarm fire | Phase 4 |
| Cognito user pool, sign-up, sign-in, any identity middleware beyond the seam Phase 1 defines | Phase 4 |
| Domain registration, the Route 53 hosted zone, ACM certificates, the API and web custom domains, `deploy-prod.yml` | Phase 5 |
| Any DynamoDB repository, entity, or key construction beyond the health check's absence of one | Phase 1 |
| The Activity model, the Add screen, any creation form, the seed script | Phase 1 |
| The recurrence engine — including "just a little of it" in `packages/shared` | Phase 2 |
| `GET /v1/agenda`, the Today screen, any of its four sections | Phase 2 |
| Lists, list items, the lists tab beyond an empty placeholder | Phase 3 |
| Attachments, presigned uploads, the media distribution's cache tuning | Phase 3 |
| Push notifications, EventBridge Scheduler, the reminder Lambda | Phase 5 |
| EAS build credentials, App Store Connect, TestFlight, a development build of the app | Phase 5 |
| The full Content Security Policy (write report-only now) | Phase 5 |
| SES domain identity and production access | Phase 5 (P5-03, identity mail — it needs the domain) / Phase 6 (production access, for guest invitations) |
| DynamoDB Streams, the maintenance Lambda | Phase 7 |
| Any `/v1/capture/*` implementation; the `501` stubs themselves are Phase 1 | Phase 8 |
| A design system beyond the primitives needed to render one screen | Phase 1 |
| Provisioned concurrency, X-Ray, WAF, a VPC | Not in v1 at all |

## Risks and gotchas

| Risk | Signal | Mitigation |
| --- | --- | --- |
| The stacks are written but never deployed, and rot | Phase 4 discovers that half the CDK code has never run | `cdk synth` on every PR (P0-29), which also bundles the API with esbuild, plus per-stack assertion tests (P0-26). Synth catches construction errors, not deployment errors — which is why P0-31 exists. |
| The deploy path is broken and nobody finds out until Phase 4 | Phase 4's first `cdk deploy` fails on bootstrap, OIDC trust, or the execution policy, tangled up with a Cognito change | P0-31 deploys and destroys one trivial stack through the real GitHub Actions OIDC path, at the end of Phase 0. |
| Local development quietly acquires an AWS dependency | Somebody points `DDB_ENDPOINT` at a deployed table "just to test something" | No table is deployed until Phase 4 (P0-31 edge cases). The `.env.example` has no AWS endpoint. There is nothing to point at. |
| A CDK context lookup makes `cdk synth` require credentials | CI's `synth` job passes on the laptop and fails on a fork PR | No `fromLookup` anywhere; environment-agnostic stacks in Phase 0; the acceptance criterion runs synth with `AWS_PROFILE` unset. |
| The account is left on the Free Plan and closes at six months | Billing → Free tier shows plan "Free" | P0-01 step 9 is a hard gate. Re-verify at the end of the phase and again before Phase 4's first deploy. |
| The health screen works on the simulator and not on a device | A spinner that never resolves, blamed on the API | P0-22 makes the physical device a gated target and renders the resolved base URL on screen so the failure is one glance rather than one afternoon. |
| Expo Go's fixed native module set is mistaken for the app's | Phase 4 adds `expo-apple-authentication` and nothing works | Noted in P0-19: the first config plugin forces a development build, and that is Phase 4's job, not a surprise. |
| Metro resolves a stale copy of `@od/shared` | Editing `shared` does not hot-reload; type errors that disappear on restart | `watchFolders` + `disableHierarchicalLookup` in `metro.config.js`, exactly as specified. Do not "fix" it by hoisting node_modules. |
| React / React Native / RNW version drift between `apps/mobile` and `packages/ui` | Invalid-hook-call errors that look like a React bug | `syncpack` in CI, `npx expo install --fix` after any Expo-managed package change, `expo-doctor` in `ci.yml`. |
| The GSI projection is set to `ALL` "for now" | Nothing, until the agenda's cost and latency are wrong | P0-12's assertion test pins `ProjectionType: INCLUDE` and the non-key attribute list. Changing it later requires replacing the index. |
| The Lambda alias is skipped and the integration points at `$LATEST` | Nothing, until a bad prod deploy needs a 30-second rollback and there is none | P0-15 wires the alias in the written stack; the CDK assertion test asserts the integration URI references it. |
| CDK bootstrap qualifier mismatch | `cdk deploy` fails naming a missing SSM parameter | Set it in both the bootstrap command and `cdk.json` in the same commit (P0-31). Bootstrap once, with one qualifier. |
| Coverage gates are added after the recurrence engine and tuned down to fit it | 100% is quietly 82% | P0-24 configures the 100% path thresholds against a placeholder file before Phase 2 starts. |
| Two copies of the path-alias table drift | Types resolve in the editor and fail in Metro, or the reverse | One declaration in `tsconfig.base.json`, mirrored deliberately in `metro.config.js` and the Vitest configs, with a resolution test per consumer (P0-06). |
