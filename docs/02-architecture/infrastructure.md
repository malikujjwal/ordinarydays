# Infrastructure

**Status:** canonical for the CDK app layout, environments, bootstrap, deployment, and
CI/CD. Service-level configuration detail lives in `aws-services.md`; this document says
how those resources are organised, created, and shipped.

Everything is AWS CDK v2 in TypeScript, in `infra/`. The only console work in the whole
project is the account creation and hardening in §3 — after that, a change that is not in
`infra/` did not happen.

> **Read §6 first.** This project is local-first: **nothing is deployed to AWS during
> Phases 0 to 3.** The stacks below are written and synthesise in CI from Phase 0, but the
> first lasting deployment is Phase 4 and the first domain is Phase 5. For four of the ten
> phases the *only* environment that exists is a laptop running DynamoDB Local, the Hono app
> under Node, and Metro — **§6 Local development**, not §3 or §4, is the section you want.
> §3's runbook opens with a table showing which of its steps happens in which phase.

---

## 1. CDK app layout

```
infra/
├─ bin/
│  └─ ordinarydays.ts        The CDK app entry point. Instantiates stacks per env.
├─ lib/
│  ├─ config.ts              EnvConfig type + dev/prod values, validated with Zod
│  ├─ stacks/
│  │  ├─ dns-stack.ts
│  │  ├─ auth-stack.ts
│  │  ├─ data-stack.ts
│  │  ├─ api-stack.ts
│  │  ├─ web-stack.ts
│  │  ├─ scheduler-stack.ts
│  │  ├─ observability-stack.ts
│  │  └─ account-stack.ts
│  └─ constructs/
│     ├─ node-lambda.ts      Opinionated NodejsFunction wrapper (arm64, bundling, logs)
│     ├─ static-site.ts      S3 + OAC + CloudFront + cache policies + URI-rewrite function
│     └─ alarm.ts            Alarm + SNS action, one signature
├─ scripts/
│  ├─ migrations/            One-off, idempotent, reviewed data scripts
│  └─ seed-dev.ts
├─ test/                     CDK assertion tests (Vitest + aws-cdk-lib/assertions)
├─ cdk.json
└─ package.json
```

### 1.1 Stacks

The suggested split from the brief is adopted with two adjustments, marked below.

| Stack | Name pattern | Resources |
| --- | --- | --- |
| `DnsStack` | `od-dns-{env}` | Route 53 hosted zone lookup, ACM certificate for `*.{domain}` (edge), ACM certificate for the API domain. Exports the zone and both certificate ARNs. |
| `AuthStack` | `od-auth-{env}` | Cognito user pool, the three app clients (`auth.md` §1.7), the user pool domain, the Apple identity provider, pre-sign-up and post-confirmation Lambdas and their roles. |
| `DataStack` | `od-data-{env}` | DynamoDB table `od-main-{env}` + `GSI1`, S3 media bucket + lifecycle rules + CORS. Exports table and bucket. |
| `ApiStack` | `od-api-{env}` | API Lambda, its execution role, the HTTP API, the `$default` route, the custom domain + API mapping + A record, access log group, throttle settings. |
| `WebStack` | `od-web-{env}` | Web S3 bucket, CloudFront distribution, OAC, cache and response-header policies, the URI-rewrite CloudFront Function, A/AAAA records, plus the **media** CloudFront distribution (see adjustment 1). |
| `SchedulerStack` | `od-scheduler-{env}` | EventBridge schedule group, the reminder Lambda + role, the scheduler-invocation role the API assumes to create schedules, the daily maintenance rule (Phase 5, P5-22). |
| `ObservabilityStack` | `od-observability-{env}` | The `od-alerts-{env}` SNS topic + email subscription, all CloudWatch alarms, the CloudWatch dashboard. |
| `AccountStack` | `od-account` | Account-scoped, environment-independent (see adjustment 2): AWS Budgets, Cost Anomaly Detection monitor, the GitHub OIDC provider and the two deploy roles. |

> **Consequence of adjustment 1, found in P0-16.** Putting the media *distribution* in
> `WebStack` while its *bucket* stays in `DataStack` makes the standard Origin Access
> Control policy impossible: OAC conditions the bucket policy on the **distribution's ARN**,
> so `DataStack` would reference `WebStack` while `WebStack` already references `DataStack`
> for the origin domain. CloudFormation rejects that as a dependency cycle, and no ordering
> of constructs avoids it.
>
> The layout is kept and the **condition** is weakened instead, for the media bucket only:
> `DataStack.allowCloudFrontRead()` grants `cloudfront.amazonaws.com` read on
> `od-media-{stage}` conditioned on `aws:SourceAccount` plus a wildcard distribution ARN,
> and `WebStack` references the bucket as an *imported* bucket so CDK does not re-add a
> policy. What the ARN condition defends against is the confused deputy — **someone else's**
> CloudFront distribution reading our bucket — and `aws:SourceAccount` closes that
> completely. What it gives up is the distinction between distributions inside this
> single-tenant account, all of which are authored in this repository.
>
> **The web bucket is unaffected**: it and its distribution are both in `WebStack`, so its
> OAC policy keeps the exact-ARN condition. `infra/test/web-stack.test.ts` asserts both,
> so the asymmetry is deliberate and visible rather than an accident.

> **Decision (adjustment 1):** `NetworkStack` is renamed `DnsStack`. There is no VPC, no
> subnet, no security group and no network in this architecture; calling the stack
> `NetworkStack` invites someone to add one. It holds DNS and certificates, so it is named
> for that. The media CloudFront distribution moves from `DataStack` to `WebStack` so that
> every CloudFront distribution and every cache policy lives in one file, and `DataStack`
> stays purely stateful (table + bucket) and therefore never needs to be touched by a
> front-end change.

> **Decision (adjustment 2):** budgets, cost anomaly detection, and the GitHub OIDC
> provider move out of `ObservabilityStack` into a separate `AccountStack` deployed
> **once**, not per environment. They are account-scoped singletons: an IAM OIDC provider
> for `token.actions.githubusercontent.com` can only exist once per account, and budgets
> track total account spend, not per-environment spend. Duplicating them per environment
> produces a deploy conflict on the second one. `ObservabilityStack` keeps the per-env
> alarms and dashboard.

### 1.2 Dependency order and cross-stack references

```
AccountStack   (independent, deployed once)

DnsStack
   ├──> AuthStack        (needs the zone for the Cognito custom domain, if used)
   ├──> ApiStack         (needs the API certificate + zone)
   └──> WebStack         (needs the edge certificate + zone)

DataStack
   ├──> ApiStack         (grants on table + media bucket)
   ├──> SchedulerStack   (reminder Lambda reads the table)
   └──> WebStack         (media distribution origin)

AuthStack ──> ApiStack   (user pool id + client ids as env vars)
ApiStack  ──> SchedulerStack  (the API's role must be able to create schedules)
all       ──> ObservabilityStack (alarms reference the functions and APIs)
```

Cross-stack references are passed as **typed construct props in the CDK app**, not via
`Fn::ImportValue` string exports. Within one CDK app in one account and region, CDK
resolves these into exports automatically and orders deploys correctly. The rule that
matters: **a stateful resource is never referenced by name-string from another stack.**
Pass the construct.

The one exception is the `RemovalPolicy` boundary: `DataStack` resources in prod carry
`RemovalPolicy.RETAIN` and deletion protection, so a `cdk destroy` of the app cannot take
the table with it.

```ts
// infra/bin/ordinarydays.ts
const app = new cdk.App();

applyAppTags(app);                                 // Project, ManagedBy, Owner — see §2.4

new AccountStack(app, 'od-account');

for (const stage of STAGES) {
  const cfg = getConfig(stage);                    // lib/config.ts, Zod-validated
  const dns  = new DnsStack(app, `od-dns-${stage}`, { cfg });
  const auth = new AuthStack(app, `od-auth-${stage}`, { cfg, dns });
  const data = new DataStack(app, `od-data-${stage}`, { cfg });
  const api  = new ApiStack(app, `od-api-${stage}`, { cfg, dns, auth, data });
  new WebStack(app, `od-web-${stage}`, { cfg, dns, data });
  const sch  = new SchedulerStack(app, `od-scheduler-${stage}`, { cfg, data, api });
  new ObservabilityStack(app, `od-observability-${stage}`, { cfg, api, scheduler: sch });
}
```

> **Amended in P0-09, two things.**
>
> **Stacks are environment-agnostic until Phase 4 — there is no `env` prop.** This snippet
> previously set `env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1' }`,
> which contradicts P0-09's own edge case: CI has no AWS role in Phase 0, so an `env` whose
> account is `undefined` at synth produces a synth that succeeds only on a machine with
> credentials configured. Phase 4 pins the environment when it first deploys. For the same
> reason no stack may call `HostedZone.fromLookup`, `Vpc.fromLookup` or any other context
> lookup.
>
> **`Tags.of(app)` was inside the stage loop**, where it ran once per stage and read as if
> it were per-stage. App-level tags are applied once, before the loop. Which tags are
> app-scoped and which are stack-scoped is now stated in §2.4.

### 1.3 The shared Lambda construct

Every Lambda goes through one construct so that runtime, architecture, bundling, log
retention, and log format cannot drift between functions.

```ts
// infra/lib/constructs/node-lambda.ts
export class NodeLambda extends Construct {
  readonly fn: NodejsFunction;

  constructor(scope: Construct, id: string, props: NodeLambdaProps) {
    super(scope, id);
    this.fn = new NodejsFunction(this, 'Fn', {
      functionName: `od-${props.name}-${props.cfg.stage}`,
      entry: props.entry,
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: props.memorySize ?? 1024,
      timeout: Duration.seconds(props.timeoutSeconds ?? 15),
      reservedConcurrentExecutions: props.reservedConcurrency,
      loggingFormat: lambda.LoggingFormat.JSON,
      applicationLogLevelV2: props.cfg.stage === 'prod'
        ? lambda.ApplicationLogLevel.INFO
        : lambda.ApplicationLogLevel.DEBUG,
      logGroup: this.logGroup,     // see the amendment below — NOT `logRetention`
      environment: { STAGE: props.cfg.stage, ...props.environment },
      bundling: {
        format: OutputFormat.ESM,
        minify: true,
        bundleAwsSDK: true,          // §2.3's decision — see the note below

        sourceMap: props.cfg.stage !== 'prod',
        target: 'node22',
        mainFields: ['module', 'main'],
        banner:
          "import{createRequire}from'module';const require=createRequire(import.meta.url);",
      },
    });
  }
}
```

The `banner` is required: some transitive dependencies still emit CommonJS `require`
calls, and an ESM bundle has no `require` in scope without it.

> **Amended in P0-10: an explicit `logGroup`, not `logRetention`.** The `logRetention` prop
> is `@deprecated use logGroup instead` in `aws-cdk-lib` 2.263, and the reason matters more
> than the deprecation. Synthesising the same function both ways:
>
> | | `logGroup` | `logRetention` |
> | --- | --- | --- |
> | `AWS::Lambda::Function` | 1 | **2** |
> | `AWS::IAM::Role` | 1 | **2** |
> | `AWS::IAM::Policy` | 0 | 1 |
> | `Custom::LogRetention` | 0 | 1 |
> | `AWS::Logs::LogGroup` | 1 | **0** |
>
> `logRetention` provisions a custom resource backed by a **second Lambda function and its
> own role**, which calls `PutRetentionPolicy` at deploy time — a Lambda that did not go
> through this construct, in a construct whose entire purpose is that every Lambda goes
> through it. And note the last row: there is no managed log group at all. Lambda creates it
> implicitly on first invocation, so it carries none of the stack's tags and survives
> `cdk destroy`.
>
> The log group is left unnamed. Naming it `/aws/lambda/od-<name>-<stage>` explicitly would
> collide on any destroy-then-recreate in prod, where `removalPolicy` is `RETAIN` and the
> orphaned group would still hold the name.
>
> Retention behaviour is unchanged: it still comes from `cfg.logRetentionDays`, and
> `infra/test/node-lambda.test.ts` asserts 14 days in dev and 30 in prod.

> **Added in P0-15: `bundleAwsSDK: true`.** `tech-stack.md` §2.3 decides we bundle the AWS
> SDK v3 clients rather than rely on the Lambda runtime's copy, because the runtime's
> version drifts and is only partially present. `NodejsFunction` defaults this to `false`,
> and the snippet above never mentioned it — so the construct was quietly doing the opposite
> of a written decision from P0-10 until P0-15 shipped the first Lambda that could import
> the SDK.
>
> Note that the flag has **no observable effect yet**: nothing imports `services/api/src/lib/
> ddb.ts` until the repository layer lands in Phase 1, so esbuild never reaches the SDK. The
> Phase 0 artifact is 409 KB unzipped / 94 KB zipped in prod. The real measurement against
> P0-28's 5 MB ceiling is the first Phase 1 task that adds a repository.

---

## 2. Environment strategy

### 2.1 One AWS account or two

> **Decision: one AWS account, two environments (`dev` and `prod`), separated by stack
> name and resource name prefix.**

The textbook answer is two accounts (or three) under an Organization, with hard blast-radius
isolation. It is the right answer for a team. It is the wrong answer here, for four
concrete reasons:

1. **Free-tier allowances are per account, not per environment.** Cognito's 10,000 MAU,
   Lambda's 1M requests, CloudFront's 1 TB, DynamoDB's 25 GB — every one of them is a
   single pool. With two accounts, dev consumes a *second* copy of nothing and prod's
   allowances are unchanged, so there is no gain; but the 12-month allowances (API Gateway
   1M calls, S3 5 GB, SES 3,000 messages) start their clock **per account**, and a dev
   account created later would have a differently-timed cliff. One account keeps one
   timeline to reason about.
2. **Billing visibility.** One bill, one set of budgets, one anomaly detector. With two
   accounts the founder needs an Organization, consolidated billing, and budgets in each
   member account to get the same picture.
3. **SES domain identity and production access are per account.** Two accounts means
   verifying the domain twice and going through the production-access review twice.
4. **Operational load.** Cross-account CDK deploys need bootstrapping with trust
   relationships, and cross-account role chaining in CI. That is real work for a solo
   founder to maintain.

The isolation that actually matters is achieved without a second account:

- Every resource name carries the stage: `od-main-dev` vs `od-main-prod`. Nothing is
  ambiguous.
- Prod stateful resources have `RemovalPolicy.RETAIN`, DynamoDB deletion protection, S3
  versioning, and PITR. Dev has none of these and may be wiped freely
  (`data-model.md` §9 explicitly permits this until Phase 5).
- The GitHub deploy roles are scoped by stack name prefix: `od-github-deploy-dev` may not
  touch `od-*-prod` stacks, and vice versa. A dev pipeline literally cannot deploy to
  prod.
- Prod deploys require a GitHub environment approval.

**Revisit when:** a second person gets AWS access, or the app holds a customer's data
under a contract that requires environment separation. At that point, migrate prod to its
own account under an Organization. Because everything is CDK, that migration is a
bootstrap plus a data export/import, not a rewrite.

### 2.2 Context-driven config

No environment branching inside stack code beyond reading `cfg`. One typed config object,
validated at synth time.

```ts
// infra/lib/config.ts
const envConfig = z.object({
  stage: z.enum(['dev', 'prod']),
  domain: z.string(),                 // dev.ordinarydays.app | ordinarydays.app
  apiDomain: z.string(),
  mediaDomain: z.string(),
  hostedZoneName: z.string(),         // always ordinarydays.app — a string, never a lookup
  logRetentionDays: z.enum(logs.RetentionDays),
  apiReservedConcurrency: z.number().int().positive(),
  pointInTimeRecovery: z.boolean(),
  removalPolicy: z.enum(cdk.RemovalPolicy),
  alertEmail: z.email(),
  sesSender: z.email(),
  webOrigins: z.array(z.url()).default([]),
});

export type EnvConfig = z.infer<typeof envConfig>;

const CONFIG: Record<Stage, EnvConfig> = {
  dev: envConfig.parse({
    stage: 'dev',
    // domain / apiDomain / mediaDomain / webOrigins are UNSET until Phase 5 registers the
    // domain. The values below are what Phase 5 will fill in, shown for shape only.
    hostedZoneName: 'ordinarydays.app',
    logRetentionDays: logs.RetentionDays.TWO_WEEKS,
    apiReservedConcurrency: 20,
    pointInTimeRecovery: false,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
    alertEmail: 'alerts@ordinarydays.app',
    sesSender: 'no-reply@dev.ordinarydays.app',
    // Phase 5 adds: webOrigins: ['https://dev.ordinarydays.app', 'http://localhost:8081'],
  }),
  prod: envConfig.parse({ /* … ONE_MONTH, 50, true, RETAIN … */ }),
};

export const getConfig = (stage: Stage): EnvConfig => CONFIG[stage];
```

> **Amended in P0-09, two things.**
>
> **Zod 4, not Zod 3.** This snippet was written against Zod 3 and P0-09 is told to follow it
> verbatim, but P0-07 closed OQ-11 on Zod 4, where the v3 spellings do not exist:
> `z.nativeEnum(X)` is `z.enum(X)`, and `z.string().email()` / `z.string().url()` are the
> top-level `z.email()` / `z.url()`. Following the old text literally would not compile.
> Every field, value and constraint is otherwise unchanged.
>
> **The four domain fields are optional and unset until Phase 5.** `domain`, `apiDomain`,
> `mediaDomain` and `webOrigins` carry no value in Phase 0 — there is no registered domain
> to name. Every stack that consumes one branches once at construction and skips the
> certificate, the custom domain and the alias record. That branch is what lets all eight
> stacks synthesise before a domain exists. `hostedZoneName`, `alertEmail` and `sesSender`
> stay required: they are plain strings that drive no lookup.

Secrets are never in this file. It contains only names, sizes, and policies — the things
that are safe in git and that a reviewer needs to see side by side.

The stage is selected by stack name (`cdk deploy 'od-*-dev'`), not by a context flag, so
there is no way to accidentally synth dev config into a prod stack name.

### 2.3 Naming conventions

| Thing | Pattern | Example |
| --- | --- | --- |
| Stack | `od-<component>-<stage>` | `od-api-prod` |
| Lambda function | `od-<name>-<stage>` | `od-reminder-dev` |
| DynamoDB table | `od-main-<stage>` | `od-main-prod` |
| S3 bucket | `od-<purpose>-<stage>-<account-id>` | `od-media-prod-123456789012` |
| Log group | `/aws/lambda/od-<name>-<stage>` | (AWS default) |
| IAM role | `od-<name>-role-<stage>` | `od-api-role-prod` |
| SSM parameter | `/od/<stage>/<domain>/<key>` | `/od/prod/auth/apple/key-id` |
| CloudWatch alarm | `od-<stage>-<metric>` | `od-prod-api-5xx` |
| EventBridge schedule | `rem_<activityId>_<userId>_<reminderId>_<occurrenceDate>` | (deterministic, so delete needs no lookup — see `../01-product/notifications.md` §3.1) |

S3 bucket names include the account ID because bucket names are globally unique across all
of AWS and `od-media-prod` will already be taken.

### 2.4 Tags

Cost Explorer is grouped by `Stage` and `Component` to answer "what is actually costing
money". Three of the five are app-scoped and applied once in `bin/ordinarydays.ts`; the
other two vary per stack and are applied by each stack's constructor, which is the whole
reason they are useful for grouping.

| Tag | Scope | Value |
| --- | --- | --- |
| `Project` | app | `ordinarydays` |
| `ManagedBy` | app | `cdk` |
| `Owner` | app | `ujjwal` |
| `Stage` | stack | `dev` \| `prod` — absent on `od-account`, which has no stage |
| `Component` | stack | `account` \| `dns` \| `auth` \| `data` \| `api` \| `web` \| `scheduler` \| `observability` |

> **Amended in P0-09.** This section said all five were applied at the app level. `Stage`
> and `Component` cannot be: they differ per stack. The helpers are `applyAppTags(app)` and
> `applyStackTags(stack, component, stage?)` in `infra/lib/tags.ts`. `account` was added to
> the `Component` values — the original list covered only the seven per-stage stacks, and
> `AccountStack` still needs to be attributable in a cost report.

Activate `Stage`, `Component`, and `Project` as **cost allocation tags** in the Billing
console after the first deploy — they only start appearing in cost reports from the day
they are activated, and they are not retroactive. Do this early.

---

## 3. Bootstrap runbook

Run once, in the order below. Steps 3.1–3.4 are console/manual; everything after is
scripted.

**This runbook is not executed in one sitting.** Development is local-first: nothing is
deployed for the first four phases, so the runbook is spread across three of them.

| Step | Phase | Why then |
| --- | --- | --- |
| §3.1 Create the AWS account | **0** (P0-01) | Opening the account takes minutes, and the Paid Plan choice must be made before the six-month Free Plan clock matters. |
| §3.2 Harden the root account | **0** (P0-02) | Worth having in place before anyone is under pressure to deploy. |
| §3.3 Administrative identity (IAM Identity Center) | **0** (P0-04) | Same. No long-lived key on the laptop, ever. |
| §3.4 Budgets before anything else | **0** (P0-03) | The safety net has to predate the first charge. |
| §3.6 Bootstrap CDK | **0** (P0-31), verified in **4** (P4-04) | Phase 0 ends with one throwaway `cdk deploy` of a single trivial `SmokeStack`, immediately destroyed, purely to prove the OIDC → bootstrap → deploy path works. Phase 4 verifies that bootstrap rather than repeating it. |
| §3.8 GitHub OIDC role | **0** (P0-31) partially, **4** (P4-06) fully | Phase 0 lands only the OIDC provider and `od-github-deploy-dev`, because the smoke test needs them. The full `AccountStack` deploy is Phase 4. |
| §3.9 First deploy | **4** (P4-06, P4-13) | The **permanent dev environment** — `AccountStack`, `DataStack`, `AuthStack`, `ApiStack`. This is the first lasting deployment in the project. No domain, no CloudFront, no prod: the API is reached at its `execute-api` endpoint and Cognito at its default hosted-UI domain. |
| §3.5 Register the domain | **5** (P5-01) | The domain, `DnsStack`, DNS and the hosted zone. This is also the first recurring AWS charge (`cost-model.md` §2.15). |
| §3.7 Certificates | **5** (P5-01) | ACM validates through the hosted zone, so it cannot happen before §3.5. |
| §3.9 again, for prod | **5** (P5-08) | Prod, deployed from a tag behind the GitHub environment approval. |

What survives Phase 0 inside AWS is exactly: the account, the console budget and anomaly
monitor, IAM Identity Center and its permission set, the CDK bootstrap stack, and the GitHub
OIDC provider with one deploy role. Every one of those is $0/month at rest. Everything else
is destroyed. Local development for Phases 0–3 uses DynamoDB Local and `AUTH_MODE=local`
(§6), with no AWS credentials at all — see `03-implementation/phase-00-foundations.md` P0-31
for the reasoning.

### 3.1 Create the AWS account

1. Go to <https://portal.aws.amazon.com/billing/signup>. Use an email address you control
   permanently and that is not a personal alias you might lose —
   `aws@ordinarydays.app` behind a forwarding rule is ideal.
2. **Critical, from the project brief:** new accounts default to the **Free Plan**, which
   grants up to $200 in credits and **closes the account after 6 months**. During signup,
   or immediately after in Billing → Account settings, **select or upgrade to the Paid
   Plan.** Always-free allowances apply on both plans, so upgrading loses nothing; staying
   on the Free Plan loses the account. Verify by checking Billing → *Free tier* shows a
   plan of "Paid" before proceeding.
3. Add a payment method. Set the account's alternate contacts (billing, operations,
   security) to the same address.

### 3.2 Harden the root account

```
Console → IAM → Security credentials (while signed in as root)
```

1. Enable MFA on root. Use a hardware key if you have one, otherwise a TOTP app whose
   seed is backed up somewhere you will still have in five years.
2. **Delete any root access keys.** There should be none; if the console shows one,
   delete it.
3. Set a strong, unique root password in a password manager.
4. Billing console → *IAM user and role access to Billing Information* → **Activate**.
   Without this, an admin IAM identity cannot see the bill, and every cost check needs
   root.
5. Do not use root again except for: closing the account, changing the support plan,
   changing the account's email or payment method, and enabling billing access.

### 3.3 Create an administrative identity

Preferred: IAM Identity Center (free, gives short-lived credentials).

```bash
# Console: IAM Identity Center → Enable (choose us-east-1 as the identity store region)
#   → Permission sets → Create → AdministratorAccess (session duration 4h)
#   → AWS accounts → assign your user to the account with that permission set
# Then, locally:
aws configure sso \
  --profile od-admin
# SSO start URL:  https://d-xxxxxxxxxx.awsapps.com/start
# SSO region:     us-east-1
# Account:        <your account id>
# Role:           AdministratorAccess
# CLI region:     us-east-1
# Output:         json

aws sso login --profile od-admin
aws sts get-caller-identity --profile od-admin
```

Every command below assumes `--profile od-admin` or `export AWS_PROFILE=od-admin`.

Fallback if Identity Center is not workable: one IAM user `od-admin` with
`AdministratorAccess`, MFA enforced, and **no** long-lived access key — use
`aws sts get-session-token` with an MFA code. Long-lived keys on a laptop are the single
most common source of a compromised AWS account.

### 3.4 Budgets before anything else

Create the zero-spend budget by hand **now**, before deploying anything, so that the very
first unexpected charge is visible. The permanent budgets are created by
`AccountStack` later; this one is the safety net during bootstrap.

```bash
cat > /tmp/budget.json <<'JSON'
{
  "BudgetName": "od-bootstrap-zero-spend",
  "BudgetLimit": { "Amount": "1", "Unit": "USD" },
  "TimeUnit": "MONTHLY",
  "BudgetType": "COST"
}
JSON

cat > /tmp/notifications.json <<'JSON'
[{
  "Notification": {
    "NotificationType": "ACTUAL",
    "ComparisonOperator": "GREATER_THAN",
    "Threshold": 1,
    "ThresholdType": "PERCENTAGE"
  },
  "Subscribers": [
    { "SubscriptionType": "EMAIL", "Address": "alerts@ordinarydays.app" }
  ]
}]
JSON

aws budgets create-budget \
  --account-id "$(aws sts get-caller-identity --query Account --output text)" \
  --budget file:///tmp/budget.json \
  --notifications-with-subscribers file:///tmp/notifications.json
```

Also enable Cost Anomaly Detection: Billing → Cost Anomaly Detection → Create monitor →
type "AWS services" → alert subscription with the same email, threshold $5.

### 3.5 Register the domain

> **Phase 5 (P5-01).** Skip this in Phases 0–4. There is no domain until v1 ships, which is
> why the Phase 4 dev environment runs on `execute-api` and `amazoncognito.com` hostnames.

```bash
# Check availability and price first
aws route53domains check-domain-availability \
  --region us-east-1 --domain-name ordinarydays.app

aws route53domains list-prices --region us-east-1 --tld app \
  --query 'Prices[0].RegistrationPrice'
```

Register through the console (Route 53 → Registered domains → Register domains) — the CLI
path requires a fully-formed contact JSON and the console validates it for you. Enable
privacy protection and **auto-renew**. A `.app` domain is on the HSTS preload list, so it
is HTTPS-only by construction, which is a small security win for free.

Registration creates a public hosted zone automatically. Capture its ID:

```bash
aws route53 list-hosted-zones-by-name --dns-name ordinarydays.app \
  --query 'HostedZones[0].Id' --output text
```

CDK looks the zone up by name (`HostedZone.fromLookup`), so the ID does not need to go
into config — but record it in the runbook notes anyway.

### 3.6 Bootstrap CDK

```bash
cd infra
pnpm install

export CDK_DEFAULT_ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
export CDK_DEFAULT_REGION=us-east-1

pnpm exec cdk bootstrap "aws://${CDK_DEFAULT_ACCOUNT}/us-east-1" \
  --qualifier odays \
  --cloudformation-execution-policies arn:aws:iam::aws:policy/AdministratorAccess
```

The custom qualifier (`odays`) namespaces the bootstrap resources so this project's
bootstrap cannot collide with another CDK project in the same account. It must also be set
in `cdk.json`:

```json
{
  "app": "pnpm exec tsx bin/ordinarydays.ts",
  "context": {
    "@aws-cdk/core:bootstrapQualifier": "odays",
    "@aws-cdk/aws-lambda:recognizeLayerVersion": true,
    "@aws-cdk/core:checkSecretUsage": true,
    "@aws-cdk/aws-iam:minimizePolicies": true
  }
}
```

> **Decision:** the bootstrap CloudFormation execution role gets `AdministratorAccess`.
> This is the CDK default and it is what lets CDK create IAM roles, Cognito pools, and
> CloudFront distributions without a hand-maintained policy that breaks on every new
> construct. The mitigation is that **nothing assumes that role except CloudFormation**,
> and the GitHub deploy roles are scoped so they can only assume the CDK roles for their
> own stack prefix. Tighten this to a scoped policy only if a second person or a third
> party ever gets deploy access.

### 3.7 Certificates

> **Phase 5 (P5-01).** Depends on §3.5.

CDK creates and DNS-validates both certificates automatically, because the hosted zone is
in the same account. No manual step is required — this is the main reason Route 53 was
chosen over external DNS (`aws-services.md` §1.7).

If you ever need one by hand:

```bash
aws acm request-certificate \
  --region us-east-1 \
  --domain-name ordinarydays.app \
  --subject-alternative-names '*.ordinarydays.app' \
  --validation-method DNS \
  --key-algorithm RSA_2048
```

Both certificates live in **`us-east-1`** — mandatory for CloudFront, and convenient here
because everything else is there too. Validation records must stay in the zone forever;
ACM re-validates on renewal.

### 3.8 GitHub OIDC role

Created by `AccountStack`, but here is what it produces, because the trust policy is the
part that must be exactly right:

```ts
// infra/lib/stacks/account-stack.ts
// CfnOIDCProvider (native CFN), not the OpenIdConnectProvider L2 — see the amendment below.
const provider = new iam.CfnOIDCProvider(this, 'GithubOidc', {
  url: 'https://token.actions.githubusercontent.com',
  clientIdList: ['sts.amazonaws.com'],
});

const devRole = new iam.Role(this, 'GithubDeployDev', {
  roleName: 'od-github-deploy-dev',
  maxSessionDuration: Duration.hours(1),
  assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
    StringEquals: {
      'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
    },
    StringLike: {
      'token.actions.githubusercontent.com:sub':
        'repo:ujjwal/ordinarydays:ref:refs/heads/main',
    },
  }),
});

const prodRole = new iam.Role(this, 'GithubDeployProd', {
  roleName: 'od-github-deploy-prod',
  maxSessionDuration: Duration.hours(1),
  assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
    StringEquals: {
      'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
      // NOTE: environment subjects use StringEquals, not StringLike.
      'token.actions.githubusercontent.com:sub':
        'repo:ujjwal/ordinarydays:environment:production',
    },
  }),
});

// Each role may only assume the CDK deploy roles for its own stage's stacks.
for (const [role, stage] of [[devRole, 'dev'], [prodRole, 'prod']] as const) {
  role.addToPolicy(new iam.PolicyStatement({
    actions: ['sts:AssumeRole'],
    resources: [
      `arn:aws:iam::${this.account}:role/cdk-odays-deploy-role-${this.account}-us-east-1`,
      `arn:aws:iam::${this.account}:role/cdk-odays-file-publishing-role-${this.account}-us-east-1`,
      `arn:aws:iam::${this.account}:role/cdk-odays-lookup-role-${this.account}-us-east-1`,
    ],
  }));
  role.addToPolicy(new iam.PolicyStatement({
    actions: ['cloudformation:DescribeStacks', 'cloudformation:DescribeStackEvents'],
    resources: [`arn:aws:cloudformation:us-east-1:${this.account}:stack/od-*-${stage}/*`],
  }));
}
```

Two things that are easy to get wrong and are load-bearing:

- The `sub` claim **must** be constrained. A trust policy with only the `aud` condition
  lets *any* GitHub repository in the world assume the role.
- The production role trusts `environment:production`, not a branch. Combined with a
  required reviewer on that GitHub environment, the approval is what mints the credential.
  A branch-scoped prod role can be triggered by anything that can push to that branch.

Because the CDK stage-scoping above is enforced via which CDK bootstrap roles the deploy
role may assume, and the bootstrap roles themselves are account-wide, add the stack-prefix
condition on the CDK role assumption as well once CDK supports per-stack deploy roles.
Until then, the GitHub **environment** gate is the real control on prod. Recorded as an
open question in `decisions.md`.

> **Amended in P0-11, two things.**
>
> **The repository is `malikujjwal/ordinarydays`.** The snippet above said
> `ujjwal/ordinarydays`. This is not cosmetic: the `sub` condition is the control that
> decides which repositories on GitHub can assume a role in this account. It lives in
> `infra/lib/config.ts` as `GITHUB_REPO`, so the trust policy and its tests cannot disagree.
>
> **`iam.CfnOIDCProvider`, not the `OpenIdConnectProvider` L2.** The L2 predates
> CloudFormation support for OIDC providers and still provisions a
> `Custom::AWSCDKOpenIdConnectProvider` backed by its own Lambda and a third IAM role.
> Synthesising `od-account` both ways:
>
> | | `CfnOIDCProvider` | `OpenIdConnectProvider` L2 |
> | --- | --- | --- |
> | `AWS::IAM::OIDCProvider` | 1 | 0 |
> | `Custom::AWSCDKOpenIdConnectProvider` | 0 | 1 |
> | `AWS::Lambda::Function` | 0 | **1** |
> | `AWS::IAM::Role` | 2 | **3** |
>
> A standing Lambda holding `iam:CreateOpenIDConnectProvider` is not something to carry by
> accident, and it is a runtime-deprecation liability in a stack that is deployed once and
> then rarely touched. `thumbprintList` is omitted deliberately: AWS manages thumbprints for
> well-known IdPs including GitHub, and a hard-coded thumbprint breaks deploys when it
> rotates.

### 3.9 First deploy

> **Phase 4 (P4-06, P4-13).** This is the first lasting deployment in the project.
> `DnsStack` stays out of the deploy set until Phase 5, and `ApiStack` deploys with no
> custom domain (P4-05).

```bash
cd infra
pnpm exec cdk deploy od-account
pnpm exec cdk deploy 'od-*-dev' --require-approval never
```

Then confirm the SNS email subscription that lands in the alert inbox — an unconfirmed
subscription means every alarm goes nowhere, silently.

Prod follows in Phase 5 (P5-08), from a tag, behind the GitHub environment approval.

---

## 4. Deployment

### 4.1 The `cdk deploy` flow

```bash
# From infra/
pnpm exec cdk diff 'od-*-dev'        # always read this before deploying
pnpm exec cdk deploy 'od-*-dev'      # dependency order is resolved by CDK
pnpm exec cdk deploy 'od-api-prod' --require-approval broadening
```

`--require-approval broadening` on prod means CDK pauses if the change widens IAM
permissions or opens a security group. In CI, prod uses `--require-approval never` because
the approval has already happened at the GitHub environment gate, and the `cdk diff`
output is posted to the PR for a human to read before that approval.

Web deploys are a separate step from infrastructure. The static export is uploaded with
`BucketDeployment` in `WebStack`, which handles the S3 sync and the CloudFront
invalidation:

```ts
new s3deploy.BucketDeployment(this, 'WebDeploy', {
  sources: [s3deploy.Source.asset('../apps/mobile/dist')],
  destinationBucket: webBucket,
  distribution,
  distributionPaths: ['/index.html', '/*.html'],   // hashed assets never need invalidating
  prune: true,
  cacheControl: [s3deploy.CacheControl.fromString('public,max-age=0,must-revalidate')],
});
```

Only HTML is invalidated. Hashed assets under `/_expo/static/` are immutable by name, so
invalidating them wastes invalidation quota for nothing.

### 4.2 What CI does

Summarised here, detailed in §7.

| Trigger | Action |
| --- | --- |
| PR opened/updated | Lint, typecheck, unit tests, `cdk synth`, `cdk diff` against dev posted as a comment, OpenAPI staleness check, bundle-size check |
| Merge to `main` | The above, then deploy all `od-*-dev` stacks, then run the web build and upload, then smoke tests against dev |
| Tag `v*.*.*` | Build once, deploy `od-*-prod` **after** a required GitHub environment approval, then smoke tests against prod, then create a GitHub release |
| Nightly | `pnpm audit`, dependency freshness check, a cost report query |

### 4.3 Rollback

Different resources roll back differently. Know which is which before you need it.

| Failure | Rollback |
| --- | --- |
| CloudFormation deploy fails mid-way | Automatic. CFN rolls the stack back to the last good state. Do nothing; read the events. |
| A stack is stuck in `UPDATE_ROLLBACK_FAILED` | `aws cloudformation continue-update-rollback --stack-name od-api-prod --resources-to-skip <logical-id>`. This is rare and always means a resource was changed outside CDK. |
| A deployed Lambda is bad but the stack is healthy | See §4.4 |
| A bad web build | Re-run the previous tag's web job, or `aws s3 sync` the previous build from the versioned bucket, then invalidate `/*`. Bucket versioning exists for exactly this. |
| A bad data migration | There is no automatic rollback for data. See §4.5. |

**The rollback of record is "deploy the previous tag."** Because the whole system is in
one repo and one CDK app, `git checkout v1.2.3 && cdk deploy 'od-*-prod'` restores both
the infrastructure and the application code to a known state. Keep prod deploys tagged and
keep the tags immutable.

### 4.4 Reverting a bad Lambda

Two mechanisms, in order of preference.

**1. Alias + version rollback (fastest, seconds).** The API Lambda publishes a version on
every deploy and an alias `live` points at it. Rolling back is repointing the alias — no
build, no CloudFormation:

```bash
# What is live now, and what came before?
aws lambda list-versions-by-function --function-name od-api-prod \
  --query 'Versions[-3:].[Version,LastModified]' --output table

aws lambda update-alias \
  --function-name od-api-prod \
  --name live \
  --function-version 41
```

The API Gateway integration targets the **alias ARN**, not `$LATEST`, which is what makes
this work. Set that up in `ApiStack` from day one:

```ts
const alias = new lambda.Alias(this, 'LiveAlias', {
  aliasName: 'live',
  version: apiFn.currentVersion,
});
new apigwv2Integrations.HttpLambdaIntegration('ApiIntegration', alias);
```

Note that an alias rollback puts the deployed infrastructure out of sync with the CDK
state. It is an emergency stop, not a fix. Follow it within the hour with a revert commit
and a real deploy, or the next `cdk deploy` will silently re-apply the bad version.

**2. Redeploy the previous tag.** Slower (a few minutes) but leaves CDK and reality in
agreement. This is the correct action once the fire is out.

Optionally, from Phase 6: gradual deployment with `LambdaDeploymentGroup`
(`LINEAR_10PERCENT_EVERY_1MINUTE`) and a CloudWatch alarm on the alias's error rate, so a
bad deploy auto-rolls-back without a human. It costs nothing (CodeDeploy for Lambda is
free) and adds ~10 minutes to a prod deploy. Worth it once there are users who notice.

### 4.5 Database migrations

DynamoDB has no schema, so "migration" means one of three things.

| Kind | Handling |
| --- | --- |
| **Additive** — a new optional attribute | No migration. The repository layer defaults it on read. This is the overwhelming majority. |
| **Shape change** — an attribute's meaning or type changes | Bump `schemaVersion` and handle it in the repository's upgrade-on-read path (`data-model.md` §9). Items are upgraded in memory on read and persisted on next write. No downtime, no backfill required. |
| **Key change** — a new access pattern needing a new key or index | Add the attribute to new writes, deploy, then run a one-off backfill script from `infra/scripts/migrations/`. Only after the backfill completes does the reading code path go live. Two deploys, never one. |

Rules for backfill scripts:

- They live in `infra/scripts/migrations/NNNN-description.ts`, are reviewed like any other
  code, and are **idempotent** — safe to run twice.
- They accept `--dry-run` (default true) and `--stage`, and log every item they would
  change before changing anything.
- They are the **only** place a `Scan` is permitted (`data-model.md` §5).
- They run from a laptop against dev first, always, and prod is run with PITR already on
  so there is a recovery point.
- Before a prod backfill, take an on-demand backup:
  `aws dynamodb create-backup --table-name od-main-prod --backup-name pre-migration-NNNN`.

Until Phase 5 ships to TestFlight, a breaking change may simply wipe `od-main-dev`
(`data-model.md` §9). After that, migrations are mandatory.

---

## 5. Secrets handling

### 5.1 Where things live

| Class | Example | Location | Read by |
| --- | --- | --- | --- |
| **Identifiers** (not secret) | table name, bucket name, user pool ID, app client ID, API base URL | Lambda environment variables; Expo `app.config.ts` `extra` for the client | Everything |
| **Server secrets** | Apple Sign in private key, Expo push access token | SSM Parameter Store `SecureString` at `/od/{stage}/…` | The API Lambda, at cold start |
| **High-value secrets** | Anthropic API key (Phase 8) | Secrets Manager `od/{stage}/anthropic-api-key` | The API Lambda, at cold start |
| **CI secrets** | none for AWS (OIDC), `EXPO_TOKEN` for EAS, `APPLE_APP_SPECIFIC_PASSWORD` | GitHub Actions repository/environment secrets | The relevant workflow job only |
| **Local dev secrets** | anything the founder needs locally | `.env.local`, gitignored, never committed | Local processes |

### 5.2 The rule

> **Nothing secret enters the repository, and nothing secret enters a Lambda environment
> variable in plaintext.**

Consequences:

- `.gitignore` covers `.env*` (except `.env.example`), `*.p8`, `*.p12`, `*.mobileprovision`,
  `cdk.out/`, and `.aws-sam/`. `.env.example` documents every variable with placeholder
  values.
- Lambda environment variables are *identifiers only*. A `console` reader of the function
  configuration — or anyone with `lambda:GetFunctionConfiguration` — learns nothing useful.
- CDK's `checkSecretUsage` context flag is enabled, so `cdk synth` fails if a
  `SecretValue` is resolved into a template at synth time.
- `gitleaks` runs in CI on every PR and fails the build on a hit. Pre-commit runs it too.
- The client bundle (`apps/mobile`) contains the Cognito app client ID and the API base
  URL, both of which are public by design. It contains **no** secret. A public OAuth client
  with PKCE has no client secret; that is the point of PKCE.

### 5.3 How the Lambda reads a secret

Once per execution environment, cached in module scope, never per request:

```ts
// services/api/src/lib/secrets.ts
const ssm = new SSMClient({});
const cache = new Map<string, { value: string; expiresAt: number }>();
const TTL_MS = 5 * 60 * 1000;

export async function getSecret(name: string): Promise<string> {
  const hit = cache.get(name);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  const res = await ssm.send(new GetParameterCommand({
    Name: `/od/${process.env.STAGE}/${name}`,
    WithDecryption: true,
  }));
  const value = res.Parameter?.Value;
  if (!value) throw new Error(`Missing secret: ${name}`);

  cache.set(name, { value, expiresAt: Date.now() + TTL_MS });
  return value;
}
```

The 5-minute TTL means a rotated secret propagates within five minutes without a redeploy,
while adding at most one SSM call per five minutes per execution environment. The IAM
policy on the API role grants `ssm:GetParameter` on `/od/{stage}/*` only, plus
`kms:Decrypt` on the account default KMS key for SSM.

---

## 6. Local development

**This is the primary development workflow, not a convenience.** For Phases 0 to 3 —
foundations, activity core, Today and tasks, plans and lists — it is the *only* environment
that exists. The whole product is built, run and tested here before a single stack is
deployed, and it stays the default loop afterwards: a change that breaks `pnpm dev` is a
regression even in Phase 9.

The goal: the full stack runs on a laptop with no AWS credentials and no internet, except
for the parts that genuinely cannot, and those do not exist until Phase 4 (Cognito sign-in)
and Phase 5 (push delivery). Until then there is nothing to reach for.

### 6.1 DynamoDB Local and MinIO

```yaml
# docker-compose.yml (repo root)
services:
  dynamodb:
    image: amazon/dynamodb-local:latest
    command: ["-jar", "DynamoDBLocal.jar", "-sharedDb", "-dbPath", "./data"]
    ports: ["8000:8000"]
    volumes: ["./.dynamodb-data:/home/dynamodblocal/data"]
    working_dir: /home/dynamodblocal
  dynamodb-admin:
    image: aaronshaf/dynamodb-admin
    ports: ["8001:8001"]
    environment:
      DYNAMO_ENDPOINT: http://dynamodb:8000
      AWS_REGION: us-east-1
    depends_on: [dynamodb]
  # Joins the stack in Phase 3 (P3-21), the first consumer of object storage.
  minio:
    image: minio/minio:latest
    command: ["server", "/data", "--console-address", ":9001"]
    ports: ["9000:9000", "9001:9001"]
    environment:
      MINIO_ROOT_USER: local
      MINIO_ROOT_PASSWORD: localsecret
    volumes: ["./.minio-data:/data"]
```

```bash
docker compose up -d
pnpm --filter @od/api ddb:create-table   # scripts/create-local-table.ts, same schema as CDK
pnpm --filter @od/api ddb:seed           # a founder-sized fixture set
pnpm --filter @od/api s3:create-bucket   # creates od-media-local in MinIO, idempotent
open http://localhost:8001               # browse items
open http://localhost:9001               # browse objects
```

`ddb:create-table` must produce the **same** key schema and GSI as `DataStack`. It reads
the definitions from a shared module that `DataStack` also imports, so the two cannot
drift. A test asserts that the synthesised CloudFormation table definition matches the
local one.

**MinIO is the local media bucket.** It speaks the S3 API, including SigV4 presigned `PUT`,
so the attachment code path is `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner`
exactly as it is when deployed. What differs between a laptop and `dev` is the endpoint and
the credentials — configuration, never a branch in application code. MinIO's root password
is the local `AWS_SECRET_ACCESS_KEY` because MinIO requires at least eight characters, and
DynamoDB Local accepts any value.

MinIO does not model CloudFront, OAC or Block Public Access. Those are properties of the
deployed bucket and distribution, asserted by the CDK tests until the stacks are deployed and
exercised against the real media domain in Phase 5 — see `phase-05-ship-v1.md`.

### 6.2 Running the API locally

The Lambda entry point is thin, so the same Hono app runs under Node directly:

```ts
// services/api/src/index.ts       (deployed)
import { handle } from 'hono/aws-lambda';
import { app } from './app';
export const handler = handle(app);
```

```ts
// services/api/src/local.ts       (dev only, never bundled)
import { serve } from '@hono/node-server';
import { app } from './app';

serve({ fetch: app.fetch, port: 3000 }, (info) =>
  console.log(`api on http://localhost:${info.port}`),
);
```

```bash
pnpm --filter @od/api dev     # tsx watch src/local.ts
```

Environment for local runs (`services/api/.env.local`):

```
STAGE=local
LOG_LEVEL=debug
TABLE_NAME=od-main-local
DDB_ENDPOINT=http://localhost:8000
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=local
AWS_SECRET_ACCESS_KEY=localsecret
MEDIA_BUCKET=od-media-local
S3_ENDPOINT=http://localhost:9000
AUTH_MODE=local
```

There is no user pool until Phase 4, so the `COGNITO_*` variables are simply absent for
Phases 0–3. From Phase 4 a developer who wants to sign in against the deployed dev pool
adds them and flips `AUTH_MODE=cognito`:

```
COGNITO_USER_POOL_ID=us-east-1_xxxxxxxxx      # the real dev pool
COGNITO_CLIENT_ID=xxxxxxxxxxxxxxxxxxxxxxxxxx  # the real dev client
AUTH_MODE=cognito
```

`lib/ddb.ts` reads `DDB_ENDPOINT` and points the client at DynamoDB Local when it is set;
`lib/s3.ts` reads `S3_ENDPOINT` the same way and adds `forcePathStyle: true` when it is
present, because MinIO does not serve virtual-hosted bucket subdomains. Both are client
construction, not conditional logic: no handler, service or repository sees the difference,
and these two variables are the only local/deployed divergence in the runtime code.

**Auth locally.** `AUTH_MODE` is a Zod enum of exactly `'local' | 'cognito'`, parsed in
`services/api/src/lib/config.ts`. It has **no default**: an unset value throws at startup.
It selects one of two `IdentityProvider` implementations behind the seam described in
`phase-01-activity-core.md` P1-01, and nothing downstream of the seam knows which is in use:

- `local`: `LocalIdentityProvider` returns the constant user ID `usr_local_dev`. It reads
  no header, parses no token, and makes no network call. This is the default development
  loop for Phases 0–3 and it still works unchanged after Phase 4.
- `cognito`: `CognitoIdentityProvider` verifies the bearer ID token against the **real dev
  Cognito pool** (§5.1 of `auth.md`). `aws-jwt-verify` needs only the public JWKS, which is
  reachable over the internet, so this works from a laptop against `localhost:3000`.

> **There is no `dev-bypass` mode and no `X-Dev-User` header.** A header-driven bypass is
> shipped code that reads attacker-controlled input to decide who you are, guarded only by
> an environment check. Tests that need a second user inject a stub provider instead:
> `createApp({ identityProvider: stubIdentity('usr_other') })`. See `testing.md` §4.3.

**The startup guard is one-directional.** `AUTH_MODE=local` with `STAGE !== 'local'` throws
at module load and refuses to serve a request. `AUTH_MODE=cognito` with `STAGE=local` is
**allowed** and is exactly how a developer signs in against the deployed dev user pool from
a laptop. Do not make the check symmetric.

**`AUTH_MODE` may appear in exactly two files:** `services/api/src/lib/config.ts` and
`services/api/src/middleware/identity.ts`. No handler, service or repository contains an
`if (AUTH_MODE …)` branch. This is enforced by a grep check in `ci.yml`, alongside the three
in [`../04-conventions/repo-structure.md#4-how-the-rules-are-enforced`](../04-conventions/repo-structure.md#4-how-the-rules-are-enforced):

```bash
! grep -rn "AUTH_MODE" services/api/src apps packages \
    --include=*.ts \
    --exclude=config.ts --exclude=identity.ts
```

### 6.3 Expo dev server

```bash
pnpm --filter @od/mobile start          # Metro, choose i / w
pnpm --filter @od/mobile ios            # iOS simulator
pnpm --filter @od/mobile web            # browser at localhost:8081
```

Turbo runs everything at once from the root:

```json
// package.json
{ "scripts": { "dev": "turbo run dev --parallel" } }
```

### 6.4 Pointing the client at local / dev / prod

One variable, resolved at build time through Expo's config, never hard-coded in a source
file:

```ts
// apps/mobile/app.config.ts
const PROFILE = process.env.EXPO_PUBLIC_PROFILE ?? 'local';

const API = {
  local: 'http://localhost:3000',
  dev:   'https://api.dev.ordinarydays.app',
  prod:  'https://api.ordinarydays.app',
} as const;

export default {
  name: PROFILE === 'prod' ? 'Ordinary Days' : `Ordinary Days (${PROFILE})`,
  slug: 'ordinarydays',
  scheme: PROFILE === 'prod' ? 'ordinarydays' : `ordinarydays-${PROFILE}`,
  ios: {
    bundleIdentifier: PROFILE === 'prod'
      ? 'app.ordinarydays.ios'
      : `app.ordinarydays.ios.${PROFILE}`,
  },
  extra: {
    profile: PROFILE,
    apiBaseUrl: API[PROFILE as keyof typeof API],
    cognitoUserPoolId: process.env.EXPO_PUBLIC_COGNITO_POOL_ID,
    cognitoClientId: process.env.EXPO_PUBLIC_COGNITO_CLIENT_ID,
  },
};
```

Distinct bundle identifiers mean the dev and prod apps install side by side on the same
device, with distinct names, so it is never ambiguous which one is open. Distinct URL
schemes keep deep links routed correctly.

On the iOS simulator, `http://localhost:3000` works directly. On a physical device, use
the machine's LAN IP and add an ATS exception for it in the **dev** app config only — never
in prod.

The corresponding EAS build profiles:

```json
// apps/mobile/eas.json
{
  "build": {
    "development": {
      "developmentClient": true, "distribution": "internal",
      "env": { "EXPO_PUBLIC_PROFILE": "dev" }
    },
    "preview": {
      "distribution": "internal",
      "env": { "EXPO_PUBLIC_PROFILE": "dev" }
    },
    "production": {
      "env": { "EXPO_PUBLIC_PROFILE": "prod" },
      "autoIncrement": true
    }
  },
  "submit": { "production": { "ios": { "ascAppId": "…" } } }
}
```

---

## 7. CI/CD

Five workflows in `.github/workflows/`. Each does one thing.

They do not all arrive at once. `ci.yml` (§7.1) is Phase 0 (P0-29) and is the only one that
runs for the first four phases, alongside a `workflow_dispatch`-only `deploy-smoke.yml` that
exists solely to prove the deploy path once (P0-31). `deploy-dev.yml` arrives in Phase 4
(P4-14); `deploy-prod.yml` and `mobile.yml` in Phase 5 (P5-08, P5-11). `nightly.yml`'s audit
and dependency checks can run from Phase 0; its cost query only becomes meaningful once
something is deployed in Phase 4.

### 7.1 `ci.yml` — validation on every PR

```yaml
name: ci
on:
  pull_request:
  push: { branches: [main] }
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version-file: '.nvmrc', cache: 'pnpm' }
      - run: pnpm install --frozen-lockfile
      - run: pnpm exec biome ci .
      - run: pnpm turbo run typecheck
      - run: pnpm turbo run test -- --coverage
      - run: pnpm run gen:openapi && git diff --exit-code docs/generated/openapi.json
      - run: pnpm --filter @od/api build && node scripts/check-bundle-size.mjs
      - uses: gitleaks/gitleaks-action@v2
      - uses: actions/upload-artifact@v4
        with: { name: coverage, path: '**/coverage/**' }

  synth:
    runs-on: ubuntu-latest
    permissions: { id-token: write, contents: read, pull-requests: write }
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version-file: '.nvmrc', cache: 'pnpm' }
      - run: pnpm install --frozen-lockfile
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::${{ vars.AWS_ACCOUNT_ID }}:role/od-github-deploy-dev
          aws-region: us-east-1
      - run: pnpm --filter @od/infra exec cdk diff 'od-*-dev' 2>&1 | tee /tmp/diff.txt
      - uses: actions/github-script@v7   # posts /tmp/diff.txt as a PR comment
```

The `synth` job assumes the **dev** role only. A PR from a fork gets no credentials at all
(`pull_request` from a fork cannot access `id-token: write`), so the diff step is skipped
there. That is correct — an untrusted PR should not be able to read the account.

Caching: `actions/setup-node`'s pnpm cache for the store, plus `actions/cache` on
`node_modules/.cache/turbo` keyed by `${{ runner.os }}-turbo-${{ github.sha }}` with a
`${{ runner.os }}-turbo-` restore key. Turbo's local cache is what makes the second and
subsequent jobs fast.

### 7.2 `deploy-dev.yml` — on merge to `main`

```yaml
name: deploy-dev
on:
  push: { branches: [main] }
concurrency: { group: deploy-dev, cancel-in-progress: false }

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: development
    permissions: { id-token: write, contents: read }
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version-file: '.nvmrc', cache: 'pnpm' }
      - run: pnpm install --frozen-lockfile
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::${{ vars.AWS_ACCOUNT_ID }}:role/od-github-deploy-dev
          aws-region: us-east-1
      - run: pnpm --filter @od/mobile exec expo export --platform web
        env: { EXPO_PUBLIC_PROFILE: dev }
      - run: pnpm --filter @od/infra exec cdk deploy 'od-*-dev' --require-approval never
      - run: node scripts/smoke.mjs https://api.dev.ordinarydays.app
      - run: pnpm exec playwright test --project=chromium
        env: { E2E_BASE_URL: 'https://dev.ordinarydays.app' }
```

`concurrency` without `cancel-in-progress` is deliberate: cancelling a CloudFormation
deploy mid-flight leaves a stack in `UPDATE_IN_PROGRESS`. Deploys queue.

`scripts/smoke.mjs` hits `GET /v1/health` (unauthenticated, returns build SHA), asserts a
`200` and that the returned SHA equals `github.sha`, then hits an authenticated endpoint
with a token minted from a dedicated test user via `AdminInitiateAuth`, and asserts `200`.
Failure fails the job and pages the alert email.

### 7.3 `deploy-prod.yml` — on tag

```yaml
name: deploy-prod
on:
  push: { tags: ['v*.*.*'] }
concurrency: { group: deploy-prod, cancel-in-progress: false }

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production          # <- the approval gate lives here
    permissions: { id-token: write, contents: read }
    steps:
      - uses: actions/checkout@v4
      # … install …
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::${{ vars.AWS_ACCOUNT_ID }}:role/od-github-deploy-prod
          aws-region: us-east-1
      - run: pnpm turbo run test
      - run: pnpm --filter @od/mobile exec expo export --platform web
        env: { EXPO_PUBLIC_PROFILE: prod }
      - run: pnpm --filter @od/infra exec cdk deploy 'od-*-prod' --require-approval never
      - run: node scripts/smoke.mjs https://api.ordinarydays.app
      - uses: softprops/action-gh-release@v2
```

### 7.4 `mobile.yml` — EAS builds

Triggered manually (`workflow_dispatch`) and on tags. Runs `eas build --platform ios
--profile production --non-interactive` with `EXPO_TOKEN` from repository secrets, then
`eas submit`. Kept separate from the AWS deploy because EAS build queues are slow and
should never block or fail an infrastructure deploy. Note that on the free EAS plan these
builds sit in a low-priority queue; see `cost-model.md` §3.

### 7.5 `nightly.yml`

`schedule: cron: '0 7 * * *'`. Runs `pnpm audit --audit-level=high`, `pnpm outdated -r`,
`npx expo-doctor`, and a cost query
(`aws ce get-cost-and-usage --granularity MONTHLY --metrics UnblendedCost`) whose result is
posted to a GitHub issue if it exceeds $1. Failures open an issue rather than failing
loudly, so a transient advisory does not block a morning's work.

### 7.6 Branch protection on `main`

| Setting | Value |
| --- | --- |
| Require a pull request before merging | Yes |
| Required approvals | 0 (solo founder) — but PRs are still required so CI runs before merge |
| Require status checks to pass | `validate`, `integration`, `synth`, `depcruise` |
| Require branches to be up to date before merging | Yes |
| Require conversation resolution | Yes |
| Require linear history | Yes (squash merge only) |
| Allow force pushes / deletions | No |
| Require signed commits | Yes |

Zero required approvals is a concession to being one person; the gate that matters is that
CI must pass and the branch must be current. When a second engineer joins, set this to 1.

### 7.7 What gates a production deploy

All of these, in order. Any one failing stops the deploy.

1. The commit is on `main` and reachable from a `v*.*.*` tag. Tags are only created from
   `main`.
2. `ci.yml` passed on that commit: lint, typecheck, unit tests, coverage thresholds
   (100% on `recurrence/` and `money/`), OpenAPI freshness, bundle size under 5 MB,
   gitleaks clean.
3. The change has already been deployed to dev by `deploy-dev.yml` and dev smoke tests and
   Playwright E2E passed.
4. **A required reviewer approves the `production` GitHub environment.** This is what mints
   the OIDC credential — without the approval, no AWS credential is ever issued to the job.
   The environment also has a 5-minute wait timer, which is enough to cancel a
   tag pushed by mistake.
5. Prod unit tests run again on the tagged tree (cheap, and catches a bad tag).
6. `cdk deploy` succeeds. CloudFormation rolls back automatically if it does not.
7. Prod smoke tests pass. If they fail, the alias rollback in §4.4 is the immediate action.

The `production` environment also restricts deployment branches to tags matching `v*`, so a
workflow triggered from any other ref cannot reach it even if someone edits the workflow
file.
