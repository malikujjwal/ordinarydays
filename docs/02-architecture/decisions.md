# Architecture decision record

Every significant technical decision, one entry each. Format: number, title, status, date,
context, decision, consequences, alternatives rejected.

**Status values:** `Accepted` (in force), `Superseded by ADR-NNN`, `Deprecated`. An
accepted decision is not re-litigated in a pull request — it is changed by a new ADR that
supersedes it.

All entries below are dated **2026-08-06**, the date the architecture documents were
written. Entries 1–11 record decisions made in the project brief; 12 onward record
decisions made in the architecture documents themselves.

---

## ADR-001 — Expo with React Native Web, one codebase for iOS and web

**Status:** Accepted · **Date:** 2026-08-06

**Context.** The product needs an iOS app and a web presence. The web presence is not
optional: concept §15 requires that people without the app can open an invite link, see a
plan, and RSVP. A solo founder is building and maintaining both.

**Decision.** One Expo (SDK 54+) codebase using React Native and React Native Web,
TypeScript strict, Expo Router for file-based routing on both platforms. Ships to iOS via
EAS Build and to the web as a static export served from S3 + CloudFront.

**Consequences.**
- One set of screens, one navigation tree, one state layer, one API client.
- Web fidelity is capped by what React Native Web renders well. Some things (drag-to-
  dismiss sheets, native pickers, haptics) are simply different or absent on web, and
  `tech-stack.md` §3.5 lists exactly which.
- The team is bound to the Expo SDK's release cadence for React Native, React, and every
  `expo-*` package. Upgrades are all-or-nothing per SDK.
- Adding Android later is close to free.
- Web bundle size is larger than a purpose-built web app's would be. Acceptable for an
  app-shell behind a CDN.

**Alternatives rejected.**
- *Native Swift + a separate web app.* Two codebases, two skill sets, two release
  processes, every feature built twice. Not viable for one person.
- *React Native + a separate Next.js web app sharing a package.* Better web output, but the
  screens are still written twice, which is where the actual work is.
- *Web-only PWA.* No App Store presence, no reliable push on iOS, no native capture flow.
  The product's capture story is camera-first.

---

## ADR-002 — DynamoDB single-table design over a relational database

**Status:** Accepted · **Date:** 2026-08-06

**Context.** The data model (`data-model.md`) has a small, closed set of access patterns,
all key-based. There are no reporting queries, no ad-hoc analytics, and no joins that
cannot be satisfied by co-locating items in a partition. The cost target is
approximately $0/month at personal scale.

**Decision.** Amazon DynamoDB, one table `od-main-{env}`, on-demand billing, one GSI. Key
design is fully specified in `data-model.md` and is not to be extended without adding an
access pattern row in the same pull request.

**Consequences.**
- The plan-detail screen — activity, participants, expenses, updates, attachments — is one
  `Query`. That is the shape the product wants.
- No schema migrations in the SQL sense. `schemaVersion` plus upgrade-on-read
  (`data-model.md` §9) handles evolution lazily.
- Every new access pattern requires deliberate key design up front. This is the real cost:
  DynamoDB punishes access patterns you did not anticipate.
- No `Scan`, no `LIKE`, no aggregate query. Counters are denormalised and maintained on
  write. Balances are a cache that must always be recomputable from the underlying rows.
- 25 GB of storage is free forever, which covers thousands of users.

**Alternatives rejected.**
- *Postgres on RDS.* No meaningful free tier after 12 months, requires a VPC, and a VPC
  requires either a NAT gateway (~$32/month) or a set of VPC endpoints for Lambda egress.
  That is more than the entire rest of the infrastructure.
- *Aurora Serverless v2.* Has a minimum-ACU floor that bills continuously even when idle.
  Same VPC problem.
- *Multi-table DynamoDB.* Loses the single-`Query` plan detail, which is the main reason to
  use DynamoDB at all here.
- *SQLite on Lambda with S3 persistence.* Cute, and broken under any concurrency.

---

## ADR-003 — Hand-rolled serverless backend over AWS Amplify Gen 2

**Status:** Accepted · **Date:** 2026-08-06

**Context.** Amplify Gen 2 would generate a backend — data layer, auth, hosting — from a
TypeScript definition, and compiles down to CDK. It is the fastest path from zero to a
deployed app.

**Decision.** Do not use Amplify. Write the CDK directly, write the API handlers directly.
Amplify Hosting is also rejected in favour of S3 + CloudFront.

**Consequences.**
- More code to write in Phase 1: a Hono app, middleware, repositories, and CDK stacks that
  Amplify would have generated.
- Complete control over the DynamoDB key design, which is the core of the data model and
  which Amplify's generated schema would fight.
- Authorisation lives in a middleware chain we control and can read, not in an annotation
  DSL.
- No vendor lock-in beyond AWS primitives. Nothing to escape from later.
- No Amplify CLI, no `amplify/` directory, no generated code checked in.

**Alternatives rejected.**
- *Amplify Gen 2.* Its generated GraphQL schema and resolvers conflict directly with the
  single-table key design in `data-model.md`. Escaping it later means rewriting the
  backend, which is a worse outcome than writing it correctly once.
- *Amplify Hosting.* It is CloudFront + S3 with a build service attached, at more cost than
  CloudFront + S3. Our build runs in GitHub Actions already.
- *SST.* Genuinely good developer experience, but it is a third-party framework layer on
  top of CDK with its own release cadence, and the local-dev "live Lambda" trick is not
  worth the dependency for a single-function API.

---

## ADR-004 — REST over GraphQL

**Status:** Accepted · **Date:** 2026-08-06

**Context.** The API surface is specified in `api-contract.md`: roughly sixty endpoints,
one client, one team. The heaviest read is `GET /v1/agenda`, which is a server-computed
projection requiring recurrence expansion — not something a client should assemble from
graph edges.

**Decision.** REST over HTTPS, JSON only, versioned under `/v1`. Zod schemas in
`packages/shared` generate the OpenAPI spec, which is checked in.

**Consequences.**
- Endpoints are explicit and enumerable. An agent can read `api-contract.md` and know the
  entire surface.
- The agenda endpoint can do exactly the right amount of work in one round trip, including
  the trimmed `AgendaItem` projection.
- Over-fetching on other endpoints is real but small, and mitigated by the trimmed
  projections and cursor pagination we already specify.
- Adding a field is additive and needs no version bump.

**Alternatives rejected.**
- *GraphQL via AppSync.* Its benefit is many clients with divergent data needs; we have one
  client. Its costs are concrete: resolver templates or JS resolvers as a second place
  logic lives, N+1 risk against DynamoDB, query-depth abuse on the public invite surface,
  and no straightforward way to run the whole API locally. Subscriptions are the one real
  draw, and v1 has no realtime requirement.
- *tRPC.* Excellent for a TypeScript monorepo and very tempting here. Rejected because the
  public invite surface must be callable by things that are not our TypeScript client
  (a shared link, a future integration, a curl command in a support conversation), and
  because an OpenAPI spec is how a new agent discovers the API without reading handlers.
  Revisit only if the public surface is ever removed.

---

## ADR-005 — One Lambda serving all routes, over one Lambda per route

**Status:** Accepted · **Date:** 2026-08-06

**Context.** API Gateway can route each path to its own function. The alternative is a
`$default` route into a single function with an HTTP router inside.

**Decision.** One function, `od-api-{env}`, with a Hono router. API Gateway has exactly one
route.

**Consequences.**
- One cold start to optimise, one bundle to keep small, one set of logs to search, one IAM
  role to review. The cold-start budget (`tech-stack.md` §4.5) is a single number.
- Warm invocations are shared across all endpoints, so a busy agenda endpoint keeps the
  rarely-used settings endpoint warm too. With per-route functions, the rare routes are
  always cold.
- The API Gateway configuration does not duplicate the route table, so it cannot disagree
  with `api-contract.md`.
- The whole API runs locally under Node with `@hono/node-server` — the same app object,
  no emulator.
- The function's IAM role is the union of every route's needs, which is less precise than
  per-route roles. Mitigated by the least-privilege policy and explicit `Deny` statements
  in `security-privacy.md` §2.2.
- The bundle contains code for every route, so a rarely-used dependency still costs cold
  start. Mitigated by lazy client creation and a 5 MB bundle ceiling enforced in CI.

**Alternatives rejected.**
- *One Lambda per route.* Sixty functions to deploy, sixty cold starts, sixty log groups,
  sixty alarms, and a CloudFormation stack slow enough to be annoying. The isolation
  benefit is real but does not pay for itself at this size.
- *A container on Fargate.* Bills continuously. Contradicts the cost model.

---

## ADR-006 — Amazon Cognito over Auth0, Clerk, or Supabase Auth

**Status:** Accepted · **Date:** 2026-08-06

**Context.** The app needs email+password and Sign in with Apple, JWT verification in
Lambda, and a cost of zero at small scale.

**Decision.** Cognito user pools, one per environment, configured in CDK. Tokens verified
with `aws-jwt-verify`.

**Consequences.**
- Free to 10,000 monthly active users, and that allowance explicitly does not expire.
- Lives in the same CDK app, the same account, and the same IAM model as everything else.
  One vendor, one bill, one outage surface.
- Cognito's developer experience is worse than the alternatives: the console is confusing,
  the SDK surface is large, error messages are unhelpful, and some newer features (refresh
  token rotation) are ahead of the CDK L2 construct's coverage and need escape hatches.
- Hosted UI customisation is limited. We use it only for the Apple federation leg and
  build our own screens for email+password.
- Migrating away later means migrating password hashes, which Cognito does not export.
  That is real lock-in and is accepted.

**Alternatives rejected.**
- *Auth0.* The best developer experience of the three. Free tier is generous but the paid
  step is steep, and it is a second vendor with a second bill and a second status page.
- *Clerk.* Excellent React integration and better UI components. Same objection: pricing
  scales with MAU and starts materially earlier than Cognito's 10,000.
- *Supabase Auth.* Would mean adopting Supabase's Postgres, contradicting ADR-002.
- *Rolling our own.* Storing password hashes, implementing recovery, rate-limiting sign-in
  attempts, and handling federation is a security-critical project on its own. No.

---

## ADR-007 — AWS CDK v2 over SAM, Terraform, or the Serverless Framework

**Status:** Accepted · **Date:** 2026-08-06

**Context.** The infrastructure spans Cognito, DynamoDB, S3, CloudFront, API Gateway,
Lambda, EventBridge Scheduler, SES, Route 53, ACM, CloudWatch, Budgets, and IAM. All of it
should be in the repository.

**Decision.** AWS CDK v2 in TypeScript, in `infra/`. The same language as the rest of the
repo, with shared types where they help.

**Consequences.**
- Infrastructure is typed and testable. `infra/test/` asserts real properties: no VPC or
  NAT gateway is ever synthesised, every log group has a retention policy, the local
  DynamoDB table schema matches the deployed one.
- Shared constructs (`NodeLambda`, `StaticSite`) mean runtime, architecture, bundling, and
  log settings cannot drift between functions.
- CDK's L2 constructs and `grant*` helpers produce correctly-scoped IAM policies without
  hand-writing ARNs.
- CDK's abstractions occasionally hide something important; escape hatches
  (`node.defaultChild as Cfn*`) are needed for newer features. That is acceptable and
  documented where used.
- CloudFormation's limits are inherited: slow deploys, occasional stuck rollbacks, and
  drift if anyone edits in the console. The mitigation is that nobody edits in the console.

**Alternatives rejected.**
- *AWS SAM.* Covers serverless primitives well and nothing else. The Cognito, CloudFront,
  Route 53, and Budgets surface would end up as raw CloudFormation YAML.
- *Terraform / OpenTofu.* Genuinely good, and multi-cloud, which we do not need. Costs: a
  separate language, a state backend to manage and lock, and a second toolchain in CI.
- *Serverless Framework.* Licence changed to a commercial model with a vendor dashboard.
  Adds a dependency on a company for something AWS provides free.
- *Pulumi.* TypeScript like CDK, but requires a state backend (theirs or self-hosted) and
  a second vendor account.

---

## ADR-008 — AI capture deferred to Phase 7, behind a stable contract from Phase 1

**Status:** Accepted · **Date:** 2026-08-06

**Context.** Natural-language and image capture (concept §2, §13) is the most distinctive
feature in the product and also the most expensive, the least predictable, and the least
necessary for the app to be useful. Model API spend at 1,000 users is projected at roughly
35× the entire AWS bill (`cost-model.md` §3.4).

**Decision.** `/v1/capture/parse`, `/v1/capture/extract`, and `/v1/capture/link` ship as
`501 not_implemented` stubs from Phase 1, with the full `ParsedCapture` response type
defined in `packages/shared` from the start. Phase 7 implements them against the Anthropic
API with the key in Secrets Manager, behind a `CaptureProvider` interface.

**Consequences.**
- The client's capture flow — composer, review screen, confidence highlighting, confirm —
  is written once, in Phase 1, against a contract that will not change.
- The product is fully usable via manual entry before any model call exists. That is the
  right order: if manual entry is not good enough, capture will not save it.
- Cost and abuse controls (20 req/hour, a per-account spend cap) are designed in from the
  start rather than bolted on after the first surprise bill.
- The `CaptureProvider` interface means switching to Bedrock, or to a different model, is a
  one-file change.
- The stub must be honest: `501`, with the client showing "coming soon", not a fake result.

**Alternatives rejected.**
- *Ship capture in Phase 1.* Unbounded cost before there is any usage signal, and it would
  block the core planning loop on prompt engineering.
- *Do not define the contract until Phase 7.* Guarantees the client capture flow is
  rewritten. The whole point of stubbing is that the integration is written once.
- *On-device models.* Not accurate enough for structured extraction from a poster, and it
  would tie the feature to iOS.

---

## ADR-009 — Expo Push Notifications over SNS with direct APNs

**Status:** Accepted · **Date:** 2026-08-06

**Context.** Reminders and shared-plan notifications need push delivery to iOS. Two paths:
Expo's push service, or SNS mobile push talking to APNs directly.

**Decision.** Expo Push Notifications, called from the reminder Lambda with the device's
Expo push token. SNS is used only as an alarm-notification topic, never for user push.

**Consequences.**
- No APNs certificate or key to manage, rotate, or lose. EAS Build already handles the
  credentials.
- No SNS platform application, no per-device endpoint ARN lifecycle, no
  endpoint-disabled cleanup job.
- `expo-notifications` on the client and the Expo Push API on the server are one integrated
  system. Free.
- A dependency on Expo's push service being up. It is a relay in front of APNs, so an
  outage delays reminders. Acceptable for this product; a missed reminder is not a data
  loss.
- Device tokens are stored as `USER#/DEVICE#` rows and deleted on sign-out and account
  deletion.
- Android, when it arrives, works through the same API with no new work.

**Alternatives rejected.**
- *SNS mobile push + APNs directly.* More control, more moving parts, and a certificate
  that expires annually and takes the feature down silently when it does.
- *Firebase Cloud Messaging.* Drags in the Firebase SDK and a Google project for a feature
  Expo already covers.

---

## ADR-010 — One AWS account with two environments, not two accounts

**Status:** Accepted · **Date:** 2026-08-06

**Context.** Standard practice is a separate AWS account per environment under an
Organization. That advice assumes a team and a compliance requirement.

**Decision.** One AWS account. `dev` and `prod` as separate CDK stacks with stage-suffixed
resource names, separated by deploy role scope and a GitHub environment approval gate.

**Consequences.**
- Free-tier allowances are per account. One account means one pool to reason about, and
  one 12-month clock rather than two started at different times.
- One bill, one set of budgets, one anomaly detector — the founder sees total spend in one
  place.
- SES domain verification and the production-access review happen once, not twice.
- No cross-account CDK bootstrap trust, no role chaining in CI.
- Blast radius is larger: a mistake with account-wide reach affects both environments. The
  mitigations are prod-only deletion protection, `RemovalPolicy.RETAIN`, PITR, stage-scoped
  deploy roles, and the production environment approval gate.
- Dev may be wiped freely until Phase 4 (`data-model.md` §9); prod cannot.

**Alternatives rejected.**
- *Two accounts under an Organization.* The correct long-term answer. Rejected now for the
  free-tier and operational-load reasons above. **Revisit when** a second person gets AWS
  access, or when a contract requires environment separation. Because everything is CDK,
  that migration is a bootstrap plus a data export, not a rewrite.
- *One account, one environment (deploy straight to prod).* No. There has to be somewhere
  to break things.

---

## ADR-011 — One unified Activity entity, not separate Plan, Task, and Meal entities

**Status:** Accepted · **Date:** 2026-08-06

**Context.** The product exposes three nouns (Today, Plans, Lists) and six activity types
(Task, Meal, Watch, Event, Outing, Custom). The obvious modelling mistake is to create a
table per noun.

**Decision.** One stored entity, `Activity`, with a `type` field and a discriminated
`details` sub-document. A "Plan" is an Activity with `schedule.date` set — there is no
`isPlan` flag and no `Plan` table. "Today" is a query, not a stored thing. Lists are the
one genuinely separate entity, because they hold things with no committed date.

**Consequences.**
- The lifecycle in the concept document — capture, organise, schedule, share, do, follow up
  — is one code path, not six near-duplicates.
- A Watch can become a Custom by changing one field. Type is a guide, not a category
  (concept §1), and the storage reflects that.
- Every activity type gets participants, expenses, reminders, recurrence, and attachments
  for free, because they hang off the same partition.
- `details` must be validated as a discriminated union where `details.kind === type`, or
  the flexibility becomes a source of malformed data.
- Type-specific behaviour lives in the presentation layer and in small pure helpers, not in
  separate services.
- Changing type must drop the fields that no longer apply, and log what was dropped.

**Alternatives rejected.**
- *A table per type.* Six half-products. The founding insight of the concept is that these
  are not separate mini-apps; splitting the storage guarantees the code fragments.
- *A `Plan` entity distinct from `Activity`.* Every scheduled activity is a plan. A separate
  entity would mean a conversion step, two IDs for one thing, and a synchronisation bug.

---

## ADR-012 — TanStack Query for server state, Zustand for client state

**Status:** Accepted · **Date:** 2026-08-06

**Context.** The client needs caching, retries, optimistic updates, and an offline mutation
queue for server data, plus a small amount of purely local UI state.

**Decision.** TanStack Query owns everything that came from the API. Zustand owns
UI-only state (composer draft, filter selections, sheet visibility, onboarding step).
The rule: **if a value originated from the API, it lives in Query's cache and nowhere
else.**

**Consequences.**
- Optimistic updates, retry with backoff, cache persistence, and paused-mutation replay are
  library features, not hand-written code.
- No copying server data into Zustand, which is the standard way stale-state bugs start.
- Two state libraries to learn. Mitigated by the boundary being crisp enough to state in
  one sentence.
- Optimistic projections (`applyCompletion` and friends) must agree with what the server
  will return, or a row visibly flips back. They are pure functions and are unit-tested.

**Alternatives rejected.**
- *Redux Toolkit + RTK Query.* Couples server-state caching to Redux, which we do not
  otherwise need. More boilerplate for the same result.
- *Only Zustand.* Would mean writing cache invalidation, retry, and offline replay by hand.
- *Only TanStack Query.* Query is not a store; UI state does not belong in a cache keyed by
  a server query.
- *Jotai.* Fine alternative to Zustand. Zustand's single-store-per-domain shape is easier
  for a coding agent to follow.

---

## ADR-013 — Biome over ESLint plus Prettier

**Status:** Accepted · **Date:** 2026-08-06

**Context.** The monorepo needs linting and formatting that run fast enough to sit in a
pre-commit hook.

**Decision.** Biome for both, one binary, one `biome.json` at the repo root with
per-workspace overrides.

**Consequences.**
- Lint plus format across the whole monorepo finishes in under a second, so the pre-commit
  hook is not something anyone wants to skip.
- No plugin resolution graph, no `eslint-config-*` chain, no Prettier/ESLint conflict
  resolution.
- The React Native lint plugin ecosystem is richer on ESLint, and Biome's
  `useExhaustiveDependencies` is newer than `react-hooks/exhaustive-deps`. The rules we
  actually depend on are all present.
- **Revisit if** a React Native-specific rule we need has no Biome equivalent. The fallback
  is ESLint flat config plus Prettier, roughly a half-day migration.

**Alternatives rejected.**
- *ESLint + Prettier.* The default, with the widest plugin coverage. Rejected on speed and
  configuration surface for a solo project.
- *oxlint.* Faster still, but does not format, so Prettier would come back.

---

## ADR-014 — The API accepts the Cognito ID token, not the access token

**Status:** Accepted · **Date:** 2026-08-06

**Context.** Cognito issues both. The convention in most guides is to send the access
token. Our authorisation needs `custom:app_user_id` — the DynamoDB tenant key — on every
request.

**Decision.** The API accepts the **ID token**, verified with `tokenUse: 'id'`.

**Consequences.**
- `custom:app_user_id` and `email`/`email_verified` are present natively on every request,
  with no pre-token-generation trigger to write and maintain.
- The `token_use` and `aud` checks make substituting one token type for the other
  impossible, so the unusual choice is not a weakness.
- It is unusual enough that it must be written down, which is why this ADR exists. Anyone
  who reads "ID tokens are for the client, access tokens are for the API" and tries to
  change it will find this entry.

**Alternatives rejected.**
- *Access token plus a pre-token-generation Lambda trigger* to inject the custom claim.
  Works, and adds a Lambda in the token issuance path — more latency on every sign-in and
  refresh, and another function to maintain, for no gain.
- *A database lookup on `sub` for every request.* An extra `GetItem` on every single API
  call to obtain a value the token could have carried.

---

## ADR-015 — Web tokens: in-memory ID token plus an HttpOnly refresh cookie

**Status:** Accepted · **Date:** 2026-08-06

**Context.** On iOS, `expo-secure-store` (Keychain) is the clear answer. On web, the choice
is between `localStorage` for both tokens, or keeping the refresh token out of JavaScript
entirely.

**Decision.** On web, the ID token is held in JavaScript memory only, and the refresh token
is held in an `HttpOnly; Secure; SameSite=Lax` cookie scoped to `.ordinarydays.app`, set by
our own API. Requires three new unauthenticated endpoints — `POST /public/v1/auth/token`,
`/refresh`, and `/logout` — **which must be added to `api-contract.md` §2.10 in the same
pull request that implements this.** Double-submit CSRF tokens on all three.

**Consequences.**
- The long-lived credential never enters JavaScript. XSS is bounded by the lifetime of the
  compromised page rather than by the refresh token's 30-day validity.
- Neither option survives XSS — a script in the page can make authenticated requests
  regardless. The gain is blast radius, not immunity, and `auth.md` §4.2 states this
  plainly rather than overselling the cookie.
- Three extra endpoints, CSRF handling, and a login flow that differs between platforms.
- The API must be on the same registrable domain as the web app for the cookie to work,
  which it is.
- A strict CSP (`security-privacy.md` §4.3) matters more than the storage choice, because
  it prevents the XSS rather than limiting it.

**Alternatives rejected.**
- *`localStorage` for both tokens.* Simplest, and one XSS gives an attacker a 30-day
  session usable from their own machine. Not acceptable for data that includes home
  addresses and who someone is having dinner with.
- *`sessionStorage`.* No better against XSS, and loses the session on every new tab.

---

## ADR-016 — SSM Parameter Store for secrets, Secrets Manager only for the model API key

**Status:** Accepted · **Date:** 2026-08-06

**Context.** The project holds roughly five secret values. Secrets Manager costs about
$0.40 per secret per month; Parameter Store `SecureString` is free at standard tier.

**Decision.** SSM Parameter Store `SecureString` for everything, at `/od/{stage}/…`. The
one exception is the Phase 7 Anthropic API key, which lives in Secrets Manager.

**Consequences.**
- $0/month for secret storage in Phases 1–6, consistent with the cost target.
- No automatic rotation. None of the Parameter Store values need it: the Apple key is
  rotated manually and rarely, and the Expo token likewise.
- The Anthropic key is the one credential whose leak has an immediate dollar cost, so it
  gets Secrets Manager's rotation tooling and CloudTrail-visible access, for $0.40/month.
- Two mechanisms to know about instead of one, documented in `aws-services.md` §1.11.

**Alternatives rejected.**
- *Secrets Manager for everything.* About $2/month for rotation we do not use on values
  that do not rotate.
- *Encrypted values in Lambda environment variables.* They appear in the console and in
  `GetFunctionConfiguration` output, and rotating one requires a redeploy.

---

## ADR-017 — X-Ray is off

**Status:** Accepted · **Date:** 2026-08-06

**Context.** Distributed tracing is standard advice for serverless.

**Decision.** X-Ray is not enabled on any Lambda in Phases 1–6. Observability is structured
JSON logs (`pino`) plus CloudWatch Logs Insights.

**Consequences.**
- The request path is one hop deep — API Gateway, Lambda, DynamoDB. A log line carrying
  `requestId`, `route`, `durationMs`, `coldStart`, and per-repository timing answers every
  question a trace would, for free.
- No SDK instrumentation, so no added cold-start cost.
- No free-tier consumption and no per-trace charge.
- If a genuinely multi-hop path appears — the Phase 6 Streams work, or Phase 7's model
  calls — turning it on is one CDK line plus an IAM policy. Deferring costs nothing.

**Alternatives rejected.**
- *X-Ray on from day one.* Pays for a capability we have no use for yet, in both money and
  init time.
- *A third-party APM (Datadog, New Relic).* Another vendor and a real monthly bill.

---

## ADR-018 — DynamoDB on-demand billing rather than provisioned

**Status:** Accepted · **Date:** 2026-08-06

**Context.** Provisioned mode at 25 RCU / 25 WCU is genuinely free forever. On-demand
request charges are not covered by that allowance.

**Decision.** On-demand (`PAY_PER_REQUEST`).

**Consequences.**
- A few cents per month at every scale in the cost model — roughly $0.45/month at 1,000
  users.
- No capacity planning, no auto-scaling configuration, and no throttling of a real user
  during a normal usage burst.
- The 25 GB free storage allowance — the part that actually matters for a data-heavy app —
  applies in either mode.
- On-demand has **no throughput ceiling**, so a runaway loop can bill without limit. That
  risk is handled at source by Lambda reserved concurrency and per-user rate limits
  (`cost-model.md` §4).

**Alternatives rejected.**
- *Provisioned at 25/25.* Free, and throttles under any burst. A user seeing errors because
  we saved forty cents is a bad trade.
- *Provisioned with auto-scaling.* Scaling reacts in minutes, which is slower than a mobile
  app's traffic spike. More configuration for a worse outcome.

---

## ADR-019 — API Gateway HTTP API rather than a Lambda Function URL

**Status:** Accepted · **Date:** 2026-08-06

**Context.** A Lambda Function URL is free and needs no API Gateway. HTTP API costs $1.00
per million requests after the 12-month free tier.

**Decision.** API Gateway HTTP API with a `$default` route and a custom domain.

**Consequences.**
- A custom domain (`api.ordinarydays.app`) with an ACM certificate, without needing
  CloudFront in front of a Function URL.
- Stage-level throttling (100 burst, 50 rps) as a cost and abuse guardrail. A request
  rejected there never invokes Lambda.
- Structured access logs.
- Roughly $0.90/month at 1,000 users in year two. Acceptable.
- **Revisit at Phase 6** if API Gateway becomes a meaningful line item. Migrating is a CDK
  change plus a DNS cutover, and Hono's adapter supports both payload formats.

**Alternatives rejected.**
- *Lambda Function URL.* Free, no custom domain without CloudFront, weaker throttle
  controls, and a different request/response format.
- *REST API (v1).* Roughly 3.5× the price of HTTP API for features we do not use.

---

## ADR-020 — Authentication in the Lambda, not an API Gateway JWT authorizer

**Status:** Accepted · **Date:** 2026-08-06

**Context.** API Gateway HTTP API supports a native JWT authorizer that validates Cognito
tokens before invoking Lambda.

**Decision.** No authorizer. `aws-jwt-verify` runs inside the Hono middleware chain.

**Consequences.**
- The public invite routes and the authenticated routes share one code path, one error
  envelope, and one rate limiter. With an authorizer, the public/private split would be
  half in CDK and half in code.
- Auth failures return the same `{ error: { code, message, requestId } }` shape as every
  other error, instead of API Gateway's own message format.
- The whole auth path runs locally with no emulator.
- Rejected requests still invoke Lambda, so an unauthenticated flood costs invocations. The
  API Gateway throttle and reserved concurrency bound that, and JWT verification against a
  cached JWKS is microseconds.

**Alternatives rejected.**
- *Native JWT authorizer.* Shifts part of the auth decision out of the repository and
  fragments the error contract, to save microseconds of compute.

---

## ADR-021 — Route 53 for DNS rather than Cloudflare

**Status:** Accepted · **Date:** 2026-08-06

**Context.** Cloudflare DNS is free; Route 53 charges $0.50/month per hosted zone. Route 53
is the first and, at small scale, largest AWS line item.

**Decision.** Route 53, with the domain registered there too.

**Consequences.**
- CDK creates and DNS-validates ACM certificates automatically against the zone. With
  external DNS, certificate validation becomes a manual step for every new environment.
- Alias records to CloudFront and API Gateway are free to query, so the hosted zone fee is
  effectively the whole cost, fixed at $0.50/month regardless of scale.
- Roughly $6/year more than the alternative. Not worth a manual step in a pipeline meant to
  be run by an agent.
- One vendor for DNS, certificates, and everything else.

**Alternatives rejected.**
- *Cloudflare DNS with the domain registered at cost.* Cheaper and has a better dashboard.
  Rejected on the automation point above.

---

## ADR-022 — No AWS WAF in v1

**Status:** Accepted · **Date:** 2026-08-06

**Context.** The public invite surface is reachable by anyone with a link.

**Decision.** No WAF. Rate limiting is done in Lambda (per user, per IP, per token) and at
the API Gateway stage throttle.

**Consequences.**
- WAF is about $5/month for a web ACL plus per-rule and per-request charges, which exceeds
  the entire rest of the infrastructure bill.
- The application-level limiter is cheaper per request than the thing it prevents (one
  DynamoDB write unit) and is testable locally.
- No managed rule sets, so no protection against novel bot patterns.
- **The trigger for adding WAF is observed abuse**, not a hypothetical. When that happens,
  a rate-based rule plus the common managed rule set is a one-afternoon change.

**Alternatives rejected.**
- *WAF from day one.* Pays a recurring cost for a threat with no evidence behind it, in a
  project whose defining constraint is cost.

---

## ADR-023 — Media served by unguessable key through CloudFront, not signed URLs

**Status:** Accepted · **Date:** 2026-08-06

**Context.** User images are private. Two ways to serve them: CloudFront signed URLs or
signed cookies, or unguessable object keys behind CloudFront with the bucket private.

**Decision.** Objects are stored at `u/<userId>/<ulid>.<ext>` — a ULID makes the key
unguessable — and served through CloudFront with Origin Access Control. The bucket has
Block Public Access fully on. The API only ever returns keys for images the caller is
allowed to see. Presigned URLs are issued for `PUT` only, never `GET`.

**Consequences.**
- No key pair to manage, no signing on every image render, and CloudFront caches
  aggressively because URLs are stable.
- A URL, once shared, works for anyone who has it until the object is deleted. For plan
  posters and meal photos that is an acceptable exposure — it is the same property a
  shared invite link has.
- Direct S3 egress is impossible: the bucket policy grants `s3:GetObject` only to
  `cloudfront.amazonaws.com` conditioned on the distribution ARN. This also keeps all image
  traffic inside CloudFront's 1 TB free egress rather than paying S3 egress rates.
- **Signed URLs are the Phase 6 hardening step** if media ever becomes sensitive enough to
  justify the key management. Listed as an open question below.

**Alternatives rejected.**
- *CloudFront signed URLs from day one.* A key pair to store and rotate, a signature on
  every render, and cache keys that change per user — which defeats CloudFront caching.
- *Presigned S3 GET URLs.* Bypasses CloudFront entirely, so it pays S3 egress from the
  first byte and loses the free 1 TB.

---

## ADR-024 — Offline means cached reads plus a mutation queue, not a local-first replica

**Status:** Accepted · **Date:** 2026-08-06

**Context.** The app must be usable on a subway. Full local-first architecture (a SQLite
mirror, CRDTs, background sync) is the maximal answer.

**Decision.** Three mechanisms and no more: a persisted TanStack Query cache, optimistic
updates on the interactions that must feel instant, and a persisted mutation queue replayed
on reconnect with client-generated idempotency keys.

**Consequences.**
- The app opens instantly with last-known data and revalidates in the background.
- Completing a task, checking a list item, snoozing, and changing an RSVP all feel
  immediate.
- Mutations made offline are replayed on reconnect and are safe to retry because every
  creating `POST` carries an `Idempotency-Key`.
- **Reads of data never fetched are unavailable offline.** Accepted.
- The agenda is a server-computed projection. Reimplementing recurrence expansion against a
  local store would duplicate the hardest logic in the product in a second place, where the
  two copies would diverge.
- Web disables the mutation queue: a closed tab that never flushes queued writes is worse
  than an error toast.

**Alternatives rejected.**
- *SQLite mirror with full sync.* Months of work, a whole class of conflict-resolution
  bugs, and a second implementation of the recurrence engine.
- *No offline support at all.* A planner that shows nothing on a subway is not a planner.

---

## ADR-025 — Bundle the AWS SDK into the Lambda artifact

**Status:** Accepted · **Date:** 2026-08-06

**Context.** The Node.js Lambda runtime ships some AWS SDK v3 clients. Marking them
external shrinks the bundle.

**Decision.** Bundle the SDK clients we use into the esbuild output, minified and
tree-shaken. Nothing AWS-related is marked external.

**Consequences.**
- Local, CI, and deployed behaviour are identical. The runtime's bundled SDK version drifts
  with AWS's runtime updates and is only partially present, which produces bugs that
  reproduce nowhere but production.
- Roughly 1–2 MB of artifact per client used, well inside limits, adding a few milliseconds
  to cold start after minification.
- Clients used on rare paths (SES, Scheduler, Secrets Manager) are created lazily inside the
  functions that need them, so their construction cost is not on every cold start.
- CI fails if the zipped artifact exceeds 5 MB.

**Alternatives rejected.**
- *Mark `@aws-sdk/*` external.* Smaller and faster, and couples correctness to a runtime
  version we do not control.

---

## ADR-026 — No custom CloudWatch metrics in Phases 1–6

**Status:** Accepted · **Date:** 2026-08-06

**Context.** The always-free CloudWatch allowance is 10 custom metrics; each beyond costs
about $0.30/month, and a metric with dimensions multiplies quickly.

**Decision.** AWS-published metrics only. Business counters are derived from structured logs
with Logs Insights queries, checked into `infra/observability/queries/`.

**Consequences.**
- $0/month for metrics at every scale in the model.
- Logs Insights queries are slower than a metric graph and cannot drive an alarm directly.
  For the questions we actually ask ("how many activities were created last week"), that is
  fine.
- Alarms are on AWS-published metrics only, which covers every failure mode in
  `aws-services.md` §1.12.
- Phase 6 may add a handful of Embedded Metric Format counters if a real operational
  question needs one.

**Alternatives rejected.**
- *Custom metrics from day one.* Pays monthly for dashboards nobody looks at yet.

---

## ADR-027 — Vitest over Jest

**Status:** Accepted · **Date:** 2026-08-06

**Context.** Unit tests for `packages/shared` and `services/api`, with near-100% coverage
mandated on the recurrence engine and money splitting.

**Decision.** Vitest, with `@vitest/coverage-v8`.

**Consequences.**
- Reuses the esbuild transform already in the toolchain, so ESM works without
  configuration ceremony.
- Fast watch mode, which matters for a test suite that is run constantly while getting
  recurrence right.
- Jest-compatible `expect` API, so agents write familiar assertions.
- The React Native side keeps `jest-expo` for component tests, because Expo's preset
  handles the RN transform chain. Two runners in the repo. Accepted: they cover disjoint
  packages, and the packages with the hard logic (`shared`, `api`) have no React in them.

**Alternatives rejected.**
- *Jest everywhere.* Slower on a monorepo and its ESM support is still awkward.
- *`node:test`.* No coverage tooling, no watch ergonomics, no mocking story.

---

## ADR-028 — CloudFront Functions for URI rewriting, not Lambda@Edge

**Status:** Accepted · **Date:** 2026-08-06

**Context.** Expo Router's static export produces `path/index.html` files. Extensionless
request URIs must be rewritten at the edge for them to resolve.

**Decision.** A CloudFront Function on viewer-request.

**Consequences.**
- Sub-millisecond execution, roughly a tenth the cost of Lambda@Edge, and a generous free
  allowance.
- No replication delay on deploy — Lambda@Edge propagation adds minutes to every change.
- Limited runtime: no network calls, no npm modules, a short execution budget. For a string
  rewrite that is irrelevant.

**Alternatives rejected.**
- *Lambda@Edge.* Overkill, slower to deploy, more expensive.
- *S3 static website hosting's routing rules.* Requires a public bucket. Not acceptable.

---

## ADR-029 — MFA optional, TOTP only, SMS disabled

**Status:** Accepted · **Date:** 2026-08-06

**Context.** Cognito supports MFA as off, optional, or required, with SMS and TOTP.

**Decision.** Pool-level `OPTIONAL`, software TOTP only, SMS disabled, opt-in from settings.

**Consequences.**
- Users who want a second factor can have one, including the founder's own account.
- Mandatory MFA on a consumer planning app with one person doing support produces
  locked-out users and support email, which is the wrong trade for this product.
- SMS is excluded because it costs money per message, requires an SNS spend-limit increase,
  and is defeated by SIM swap.
- Setting `OPTIONAL` from day one means the `AssociateSoftwareToken` flow is exercised from
  the start rather than bolted on later.

**Alternatives rejected.**
- *MFA off.* Leaves no path for a user who wants it, and switching a live pool later is
  more disruptive.
- *MFA required.* Correct for a bank. Wrong here.

---

## ADR-030 — `AccountStack` separated from per-environment stacks; `NetworkStack` renamed `DnsStack`

**Status:** Accepted · **Date:** 2026-08-06

**Context.** The suggested stack split placed budgets and the GitHub OIDC provider in a
per-environment `ObservabilityStack`, and named the DNS/certificate stack `NetworkStack`.

**Decision.** Account-scoped singletons — AWS Budgets, Cost Anomaly Detection, the GitHub
OIDC provider, and the two deploy roles — move to a separate `AccountStack` deployed once.
`NetworkStack` is renamed `DnsStack`.

**Consequences.**
- An IAM OIDC provider for `token.actions.githubusercontent.com` can exist only once per
  account; duplicating it per environment fails on the second deploy. Budgets track total
  account spend, which is not a per-environment concept.
- `ObservabilityStack` keeps the per-environment alarms and dashboard, which is a coherent
  scope.
- There is no VPC, subnet, or security group in this architecture. Naming a stack
  `NetworkStack` invites someone to add one, which would bring a NAT gateway and break the
  cost model (`cost-model.md` §4). Naming it for what it holds prevents that.
- The media CloudFront distribution also moves from `DataStack` to `WebStack`, so every
  distribution and cache policy lives in one file and `DataStack` stays purely stateful.

**Alternatives rejected.**
- *Keep the suggested split.* The OIDC provider collision is not a matter of taste; it
  fails to deploy.

---

## Open questions

Genuinely undecided. Each needs a decision before the phase named.

| # | Question | Needed by | Notes |
| --- | --- | --- | --- |
| OQ-1 | Should media move to CloudFront **signed URLs**? | Phase 6 | ADR-023 accepts unguessable keys for now. If users start attaching documents, receipts, or anything with a face in it that they would not share, signed URLs become worth the key management. Decide after seeing what people actually upload. |
| OQ-2 | Can the GitHub deploy roles be scoped **per stack prefix** at the CDK bootstrap level? | Phase 3 | Today the stage separation relies on the GitHub `production` environment approval gate. CDK's bootstrap roles are account-wide, so `od-github-deploy-dev` could in principle assume a role that touches prod stacks. Investigate per-stack deploy roles or a policy condition on the CloudFormation stack name. |
| OQ-5 | Which **model** and which **provider** for Phase 7 capture? | Phase 7 | ADR-008 defers this behind a `CaptureProvider` interface. The decision needs a real accuracy evaluation against a corpus of actual posters and screenshots, plus current pricing, plus written confirmation that API inputs are excluded from training. |
| OQ-6 | Is there a **paid tier**, and does capture sit behind it? | Phase 7 | `cost-model.md` §3.4 projects model spend at roughly 35× the AWS bill at 1,000 users. Unlimited free capture does not work economically. A free monthly quota with paid capture above it probably does. This is a product decision, not a technical one. |
| OQ-7 | When does **prod move to its own AWS account**? | When a second person gets access | ADR-010 accepts one account for now and states the trigger. The migration path (bootstrap the new account, export/import the table, cut DNS over) should be written down before it is needed. |
| OQ-8 | Does the **web build need web push**? | Phase 6 | Currently a no-op stub. Requires a service worker, VAPID keys, and a separate permission model, none of which Expo abstracts. Only worth it if web turns out to be a primary surface rather than the invite-page surface. |

---

## Resolved questions

Recorded here rather than deleted, so a reader who remembers the question can find the
answer and where it was made.

| # | Question | Resolved in | Resolution |
| --- | --- | --- | --- |
| OQ-3 | What is the **Lambda memory setting** that actually minimises cost and latency? | `03-implementation/phase-08-followup-and-launch.md` P8-15 | Run AWS Lambda Power Tuning against the dev API function over 512/768/1024/1536/2048 MB, record the curve in `docs/05-operations/perf/lambda-power-tuning.md`, and set `memorySize` from it. **Unresolved:** `phase-04-ship-v1.md` P4-28 also claims this measurement for Phase 4. One of the two owns it; pick one. |
| OQ-4 | Does **refresh token rotation** need a CDK escape hatch? | `03-implementation/phase-01-activity-core.md` P1-01 | Check the CDK version in the lockfile; if the `UserPoolClient` L2 has no property, use the `CfnUserPoolClient` escape hatch in `auth.md` §1.6 with a 60-second retry grace period. Rotation is not optional. |
| OQ-9 | What is the **guest-email lookup partition**? | `03-implementation/phase-05-sharing.md` P5-25 | `GUESTEMAIL#<lowercased-email>` is now in `data-model.md` §3.4 with access pattern 14b. |
| OQ-10 | Do the three **web auth endpoints** belong on the public prefix? | `03-implementation/phase-01-activity-core.md` P1-22 | Yes, on `/public/v1/auth/*`, with their own limit of 10 req/min per IP and an additional 60/hour per IP on `/refresh`. Recorded in `api-contract.md` §2.0. |
| OQ-11 | Is `zod` v4 viable, or does `zod-to-openapi` pin us to v3? | `03-implementation/phase-00-foundations.md` P0-09 | Decided at scaffold time from the lockfile: pin `zod@3` if `zod-to-openapi` does not support v4, with the pin commented in `package.json`. `tech-stack.md` §2.2 carries the resulting range. |
| OQ-12 | Does **`.ics` generation** need a library, and which one? | `03-implementation/phase-05-sharing.md` P5-08 | No library. A typed builder in `packages/shared/src/ics/` with its own escaping, 75-octet folding, golden files and a parser-oracle test. |
