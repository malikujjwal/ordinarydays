# Architecture decision record

Every significant technical decision, one entry each. Format: number, title, status, date,
context, decision, consequences, alternatives rejected.

**Status values:** `Accepted` (in force), `Superseded by ADR-NNN`, `Deprecated`. An
accepted decision is not re-litigated in a pull request — it is changed by a new ADR that
supersedes it.

Entries 1–30 are dated **2026-08-06**, the date the architecture documents were written.
Entries 1–11 record decisions made in the project brief; 12–30 record decisions made in the
architecture documents themselves. Later entries carry their own dates and record decisions
made after that pass: 31–36 the list-model change, 37–40 plans without dates, 41–44
shared lists, and 45–51 the review resolutions of 2026-08-07.

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
- More code to write in Phases 0 and 1: a Hono app, middleware, repositories, and CDK stacks
  that Amplify would have generated.
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

## ADR-008 — AI capture deferred to Phase 8, behind a stable contract from Phase 1

**Status:** Accepted · **Date:** 2026-08-06

**Context.** Natural-language and image capture (concept §2, §13) is the most distinctive
feature in the product and also the most expensive, the least predictable, and the least
necessary for the app to be useful. Model API spend at 1,000 users is projected at roughly
35× the entire AWS bill (`cost-model.md` §3.4).

**Decision.** `/v1/capture/parse`, `/v1/capture/extract`, and `/v1/capture/link` ship as
`501 not_implemented` stubs from Phase 1, with the full `ParsedCapture` response type
defined in `packages/shared` from the start. Phase 8 implements them against the Anthropic
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
- *Do not define the contract until Phase 8.* Guarantees the client capture flow is
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
- Dev may be wiped freely until Phase 5 (`data-model.md` §9); prod cannot.

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

**Decision.** One stored entity, `Activity`, with an explicit `objectKind: 'task' | 'plan'`,
a `type` field, and a discriminated `details` sub-document. `objectKind` records which
creation target the user or labelled entry point chose; it is not a second entity. There is
no `Plan` table. "Today" is a query, not a stored thing. Lists are the one genuinely separate
entity because ListItems are not schedulable Activities.

> **Amended by ADR-045 and ADR-046.** This entry originally read "a Plan is an Activity with
> `schedule.date` set", then derived plan-hood from type and participants. Both derivations
> are superseded. A date is scheduling state; `objectKind` is explicit intent.

**Consequences.**
- The lifecycle in the concept document — capture, organise, schedule, share, do, follow up
  — is one code path, not six near-duplicates.
- A Watch can become a Custom without changing its `objectKind`. Type is a guide, not the
  Task/Plan decision, and the storage reflects that.
- The one Activity partition supports expenses, reminders, recurrence, and attachments for
  both object kinds, plus participants for Plans. Prep-task collaboration is inherited from
  the parent Plan rather than stored as direct Task participants.
- `details` must be validated as a discriminated union where `details.kind === type`, or
  the flexibility becomes a source of malformed data.
- Type-specific behaviour lives in the presentation layer and in small pure helpers, not in
  separate services.
- Changing type must drop the fields that no longer apply, and log what was dropped.

**Alternatives rejected.**
- *A table per type.* Six half-products. The founding insight of the concept is that these
  are not separate mini-apps; splitting the storage guarantees the code fragments.
- *A `Plan` entity distinct from `Activity`.* A plan is an Activity carrying commitment or
  coordination, dated or not. A separate entity would mean a conversion step, two IDs for one
  thing, and a synchronisation bug on the day a date lands.

---

## ADR-012 — TanStack Query for server state, Zustand for client state

**Status:** Accepted · **Date:** 2026-08-06

> **Amended by ADR-057 (2026-08-18).** This remains the web rule. After a native domain
> migrates, typed SQLite repositories own its visible state and TanStack is transport
> machinery; Zustand remains UI-only. Shared repository/use-case interfaces bind both
> adapters.

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
one exception is the Phase 8 Anthropic API key, which lives in Secrets Manager.

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
- If a genuinely multi-hop path appears — the Phase 7 Streams work, or Phase 8's model
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
- **Revisit at Phase 7** if API Gateway becomes a meaningful line item. Migrating is a CDK
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
  *(Amended 2026-08-26 by P3-23: on the **media** bucket the condition is
  `aws:SourceAccount` plus a wildcard distribution ARN, not the exact ARN. Its distribution
  is in `WebStack` and its bucket in `DataStack`, so an exact-ARN condition is a
  CloudFormation dependency cycle — `infrastructure.md` §1.1 has the reasoning. The
  consequence above is unchanged: the principal is still only `cloudfront.amazonaws.com`,
  so direct S3 egress remains impossible and the decision stands as accepted.)*
- **Signed URLs are the Phase 7 hardening step** if media ever becomes sensitive enough to
  justify the key management. Listed as an open question below.

**Alternatives rejected.**
- *CloudFront signed URLs from day one.* A key pair to store and rotate, a signature on
  every render, and cache keys that change per user — which defeats CloudFront caching.
- *Presigned S3 GET URLs.* Bypasses CloudFront entirely, so it pays S3 egress from the
  first byte and loses the free 1 TB.

---

## ADR-024 — Offline means cached reads plus a mutation queue, not a local-first replica

**Status:** Accepted · **Date:** 2026-08-06

> **Amended by ADR-057 (2026-08-18).** Accepted as written for web. For a migrated native
> domain, the runtime materialization is superseded: typed SQLite repositories own visible
> state after cutover. The rejection below of a *SQLite mirror with full sync* stands —
> ADR-057 adopts a bounded, domain-specific application model, not a mirror, and
> existing-series recurrence expansion stays on the server.

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

## ADR-026 — No custom CloudWatch metrics before Phase 8

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
- Phase 8 adds the first handful of Embedded Metric Format counters, for capture (P8-29),
  because the model spend there is the one thing a log query cannot watch cheaply enough.

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

## ADR-031 — Three list behaviours, not eight list kinds

**Status:** Superseded by ADR-058 · **Date:** 2026-08-07

**Context.** Lists were modelled as a closed enum of eight `ListKind` values — `groceries`,
`shopping`, `packing`, `general`, `restaurants`, `places`, `meals`, `watchlist`. The enum
carried two unrelated jobs at once: it told the application how to behave, and it told the
user what the list was for. That coupling has three costs. Adding "Bars to try" or "Books to
read" means a schema change, a migration and a new branch in every exhaustive map. The enum
is simultaneously too small for what users want to keep lists of and too large for the
number of genuinely different code paths — `groceries`, `shopping` and `packing` differed
from each other in nothing but their label and icon. And `general` became the dumping ground
for everything the enum did not anticipate, which is the enum admitting it is the wrong
shape.

**Decision.** Replace `ListKind` with `ListBehaviour`, exactly three values:

| Behaviour | Why it exists |
| --- | --- |
| `collection` | An ordered list of items. Differences between groceries, packing, restaurants and reference lists are capability flags on the row, not code. |
| `watch` | Items group under status headings and carry season and episode. The only behaviour whose item list is grouped rather than flat. |
| `meals` | Items carry structured `ingredients`, which feed the ingredients-to-list flow and map onto `Activity.details` for `type: 'meal'`. |

What a `collection` can do is carried by `ListCapabilities` — `checkable` and
`supportsLocation` — stored on the list and editable by the user. The user sees no such word
as "behaviour"; they see a template name and an icon (ADR-032). Scheduling is an explicit
Plan-creation action, so no capability chooses an Activity type.

**The standard for a fourth behaviour:** *does the application actually behave differently,
or does only the label differ?* A fourth behaviour must name at least one of: a different
item layout, a typed field no other behaviour carries, or a cross-entity flow that exists
nowhere else. If the answer is a different name, a different icon, or a different default
for a flag that already exists, it is a template and it needs no ADR. `Simple` versus
`Checklist` fails this test — they are `collection` with `checkable` false and true.
`Groceries`, `Shopping`, `Packing`, `Restaurants` and `Places` all fail it too.

**Consequences.**
- The exhaustive `Record<ListKind, ActivityType>` map disappears. The scheduling request
  carries the type the user confirmed; neither behaviour nor template maps to one.
- The item renderer branches on three behaviours and reads flags. Adding a list type adds no
  branch, so the renderer stops growing.
- Behaviour is user-changeable, which the closed enum never had to handle. `collection →
  watch` or `meals` initialises `details` on every item; the reverse direction drops typed
  fields and is gated behind an explicit confirmation (`api-contract.md` §2.7).
- `data-model.md` §10 lists a fourth behaviour as deliberately not modelled, so adding one
  is a product decision rather than a pull request.

**Alternatives rejected.**
- *Keep the eight kinds and add more.* Every new kind is a schema change plus a branch in
  every exhaustive map, and the enum never converges — there is no finite list of things
  people keep lists of.
- *One behaviour and pure capability flags.* Grouping watch items under status headings and
  typing meal ingredients are real differences in the application, not flags. Flattening
  them would push the branch into the renderer under a different name and lose the
  `ingredients` typing that the meal scheduling path depends on.
- *A free-text `kind` string with no meaning to the server.* Loses the capability defaults
  and turns every list into a bare checklist.

---

## ADR-032 — List templates are declarative presets, copied at creation

**Status:** Accepted · **Date:** 2026-08-07

**Context.** Three behaviours are not what a user picks from. They pick "Groceries",
"Packing for a trip", "Restaurants to try". Something has to hold that vocabulary, and it
must be cheap enough to extend that adding "Bars to try" is not a project.

**Decision.** A declarative catalogue in `packages/shared/src/lists/templates.ts`: a plain
array of `ListTemplate` records, each holding a `templateKey`, chooser label, one-line summary,
editable default title, icon, behaviour, capability defaults, slot and empty-state copy. It is
unbounded — adding an entry is a config change with no schema change, no branch and no migration.

Templates are **seeds, not live references**. `POST /v1/lists` resolves the template once
and copies behaviour, capabilities, slot, icon and empty-state copy onto the `List`.
`templateKey` is retained as immutable provenance and analytics only; no renderer or read
path resolves it back through the catalogue.

The flow is selection-first: the user chooses a template/style, then confirms its visible,
editable default title and creates the list. Both `templateKey` and `title` are required. The
server resolves only that exact catalogue entry; it does not rank or replace it from title
text, and there is no title-suggestion endpoint or implicit `simple-list` fallback. Create
does not accept behaviour, capability, slot, icon or empty-state-copy overrides; supported
structural settings are explicit later changes, while the copied presentation stays local to
that List.
When an explicitly selected template is used to create a list from a Plan, the server stores
`sourceActivityId` and forces `slot: null`, so one trip's list cannot silently become a
standing destination.

**Consequences.**
- Editing a template changes what new lists get and never touches an existing list. The same
  freezing principle as `sourceLabel` on a grocery item: a list must not change shape
  underneath the person holding it.
- The cost is drift. Two users who each made a "Groceries" list six months apart can hold
  different seeded behaviour, capabilities, slot, icon or empty-state copy, and there is no
  backfill. This is recorded as a tension in
  `feature-to-schema-map.md` §11 rather than treated as a bug.
- The catalogue is a static asset, so `GET /v1/list-templates` is cacheable for 24 hours and
  needs no storage.
- A create request with no template is invalid, so there is exactly one explicit
  selection-first code path and no fallback path to keep in sync.
- A user customises the supported List settings—behaviour, capabilities and slot—directly.
  They never edit a template, because a template is not a thing they own; copied icon and
  empty-state guidance remain local presentation values without a v1 editor.

**Alternatives rejected.**
- *Resolve seeded fields from the template at read time.* Makes every list a live view of a
  catalogue the user cannot see, so a release could silently make a list checkable or move
  where their ingredients go. It also couples the client's rendering to a shipped constant
  the server does not control.
- *Store templates in DynamoDB.* A read on every creation, a migration path, and an admin
  surface, for data that changes when the app ships.
- *User-authored templates.* Deferred — see `../00-open-decisions.md`. The catalogue ships
  with the app in v1, and a user's own list with edited capabilities already covers most of
  the want.

---

## ADR-033 — Semantic default slots, not behaviour-keyed defaults

**Status:** Accepted · **Date:** 2026-08-07

**Context.** "Add these ingredients to a shopping list" needs a target. When lists were
keyed by kind, `kind === 'groceries'` answered it. Once groceries, packing and shopping are
all `collection`, behaviour cannot: the flow would have to choose between a user's Costco
list, their corner-shop list and their packing list for Lisbon, and it has nothing to choose
on.

**Decision.** A `slot` on the `List` — `groceries | watch | meals`, or `null` — declaring
that the list is eligible to be a destination, plus `User.defaultLists`, a `slot → listId`
map recording which one wins when several are eligible. Resolution for any "add to X" flow
is four steps: one eligible list, use it silently; several with a default set, use the
default, show it, and allow an override **for that operation only**; several with no
default, ask once and store the answer; none, return no destination. General and ingredient
flows then offer the full standard New-list catalogue unselected. A typed Watch destination,
already chosen explicitly by the user, offers exactly the three Watch records in canonical
relative order, also unselected. Slot resolution never chooses or returns a template; the
client applies that eligibility constraint. Creating the List and then adding the items are
separate named confirmations.

`slot` is seeded from the template and changeable in settings, so a user who built a plain
collection for their shopping can promote it. Per-occasion templates such as packing seed
`null`.

**Consequences.**
- The destination is a stated preference, not an inference. The user can see it, change it
  in settings, and predict it.
- Three slots is a closed set that mirrors the three cross-entity flows that exist. A fourth
  slot needs a fourth flow first.
- Opening a list writes nothing, so browsing a list cannot change where future items go.
- A one-off override is a request parameter, not a profile write, so choosing a different
  destination once does not quietly become permanent.
- The sheet must show the resolved destination even when it did not ask, or step 2 becomes
  invisible and the user cannot tell where their items went.

**Alternatives rejected.**
- *Most-recently-used.* Explicitly rejected. It makes the destination a side effect of
  browsing: opening a list to check whether you already have eggs would silently redirect
  tomorrow's ingredients. Destinations must be chosen, not accumulated.
- *Always ask.* A modal on every ingredient add, forever, for a user with one grocery list.
- *Key the default off `behaviour`.* The problem this decision exists to solve — every
  collection would be equally eligible.
- *A single `isDefault` boolean per list.* Cannot express "this is my groceries list and
  that is my watchlist" without a second field naming what it is default *for*, which is the
  slot under another name.

---

## ADR-034 — A list-item Activity pointer is singular per viewer in v1

**Status:** Accepted · **Date:** 2026-08-07

**Context.** The relationship between a list item and Activities derived from it is
one-to-many: ten episodes can be scheduled from one watchlist entry, and two members of a
shared restaurant list can make unrelated private Plans. A single Activity id on the shared
ListItem makes one member's private Plan visible as a dead link to everybody else and lets a
second member overwrite or rename it.

**Decision.** The ListItem carries no Activity id. The list partition stores a fixed-key
`ListItemActivityLink` at `LNK#<viewerUserId>#<itemId>`, containing one current `activityId`
for that viewer and item. Each Activity keeps `listItemId` and `listId` back-pointers.

`Just me` writes only the caller's pointer. `Choose people` writes pointers for the caller
and selected registered Plan participants who are active members of the source list. A
nonparticipant member receives no pointer. A later scheduling action replaces only its
viewers' pointers.

**Consequences.**
- The list row renders at most one caller-specific state line — `Planned Saturday · 7 PM` —
  and every state line opens an Activity the caller can read.
- An unbounded array on a hot, frequently rewritten item is avoided, along with the write
  contention and item-size growth it brings.
- Different list members can schedule the same item independently; another viewer's pointer
  is neither a conflict nor response data.
- History is not queryable from the list side. The Activity back-pointers preserve
  provenance, but v1 does not offer "every time I watched this show".
- The list-detail projection must filter `LNK#` rows to the caller before Activity lookup or
  serialisation. This privacy boundary is tested in `security-privacy.md` §1 row 15a.
- The item title seeds a new Plan once and is not mirrored afterwards. Otherwise a list
  editor could rename an inaccessible private Plan.

**Upgrade path.** When history is needed, add Activity-specific link rows under the existing
list partition and keep `LNK#<viewer>#<item>` as the current pointer. That is additive and
backfillable from each Activity's `listItemId`, `listId`, owner, and participants.

**Alternatives rejected.**
- *An array of activity ids on the item.* Unbounded growth on the row the UI writes most.
- *One global pointer on the ListItem.* Leaks inaccessible Plan existence and cannot
  represent independent scheduling by members.
- *No pointer at all, deriving the link from the Activity side.* Rendering a list of 200
  items would need a query per item or a GSI whose only job is this one line of subtitle.

---

## ADR-035 — Lists are independent collections, not a staging area for plans

**Status:** Accepted · **Date:** 2026-08-07

**Context.** The original concept frames the product as a pipeline: *Lists → Plans → Today*.
Read as architecture, that says a list is where things wait until they become plans, and an
item that never gets scheduled is unfinished. Building it that way produces a Lists tab that
behaves like an inbox: a queue to be drained, with completion pressure attached to every
row.

Most real lists are not queues. Favourite restaurants, books read, bars in the
neighbourhood, gift ideas, things to pack — these are references. Some are never scheduled,
and nothing is wrong when they are not.

**Decision.** Lists are independent collections. A list that never produces an Activity is a
complete, finished thing. The bridge to Activities is optional in both directions: an item
may be scheduled, an activity may generate a list, and neither is required by the other.
Nothing in the storage, the API or the UI treats an unscheduled item as pending.

**This supersedes the *Lists → Plans → Today* framing as an architectural statement.** The
original concept still wins on intent, and it is right about what matters: the connection
between the three surfaces is the product, nothing is duplicated when a list item becomes a
plan, and the loop closes when the plan is done. What changes is only the claim that the
arrow is the point. It is one of the things a list can do.

**Consequences.**
- The Lists index is a set of destinations rather than a queue, so it needs no "remaining"
  count, no completion pressure and no aging.
- A list item with no caller-visible `ListItemActivityLink` is the ordinary case, and the
  schema treats it as one row with no Activity lifecycle.
- `sourceActivityId` on a list is a provenance label, not ownership: deleting a trip leaves
  its packing list, and completing a trip does not archive it.
- Scheduling stays a first-class flow with a first-class endpoint. Nothing about this
  decision demotes it.
- `feature-to-schema-map.md` §4 leads with the unlinked list and treats scheduling as the
  second case, so an agent reading it builds the common case first.

**Alternatives rejected.**
- *Lists as a queue of unscheduled Activities.* Was considered and rejected in ADR-011 for
  storage reasons; it is rejected here for product reasons as well. Every reference item
  would carry a status, an index entry and an implied obligation.
- *Two list types, "reference" and "actionable".* A behaviour that fails the ADR-031 test —
  the application would do nothing differently, and users would put items in the wrong one.

---

## ADR-036 — Capture is manual until Phase 8, and the Phase 5 launch is a manual planner

**Status:** Accepted · **Date:** 2026-08-07

**Context.** ADR-008 defers the capture implementation to Phase 8 behind a contract stubbed
from Phase 1. What that ADR does not say out loud is what the ordering costs, and the
omission invites a well-meaning agent to "fix" the roadmap by pulling capture forward.

Stated honestly: **the Phase 5 demo does not contain the product's differentiator.** What
ships to TestFlight is a manual planner. Everything a tester sees at that point — Today,
Plans, Lists, reminders, recurrence — they typed in themselves. Natural-language and image
capture, the thing the concept leads with, is three phases later.

That was chosen, not conceded. `/v1/capture/parse` and `/v1/capture/extract` receive an
explicit `CreationTarget` and return only fields compatible with that target; a model
integration built before the Activity and ListItem models are settled gets rewritten when
those models move. Capture also has no product without a place to land: the review screen is
a host that confirms extracted values against a real Task, visible Plan type, or selected
list. It never chooses participants. Confirming into a surface that does not exist yet is not
testable. Building the integration first would mean paying model spend to debug a schema.

**Decision.** The sequencing stands. v1 at Phase 5 ships as a manual planner and is
described as one. Capture arrives at Phase 8, after the activity model is stable and the
review-screen host works. No phase is reordered to bring it forward, and the Phase 5
milestone is not written as though it contains it.

**Consequences.**
- Phase 5 must be honest in every place it is described. `03-implementation/roadmap.md`
  §1.6 says so; App Store copy, TestFlight release notes and any demo must match.
- Early testers evaluate the planning loop on its own merits, which is the useful signal: if
  manual entry is not good enough, capture does not rescue it.
- The gap between "what the concept promises" and "what the beta does" is real and will come
  up in tester feedback. That feedback is about Phase 8's priority, not evidence that the
  order was wrong.
- OQ-6 (does capture sit behind a paid tier) can be answered against real usage numbers
  gathered in Phases 5–7 rather than against a guess.
- An agent asked to move capture earlier cites this ADR and stops.

**Alternatives rejected.**
- *Ship a reduced capture in Phase 5 — text only, no images.* The text path is the one that
  most needs a settled activity model, and it carries the same per-call cost, the same abuse
  surface and the same review screen. It halves the value and none of the work.
- *Delay v1 until capture is ready.* Nothing ships for three extra phases, the planning
  loop gets no real-user feedback, and the first thing real users see is also the first
  thing that can produce a wrong answer.
- *Describe Phase 5 as feature-complete and treat capture as an enhancement.* It is not an
  enhancement; it is the reason the product is interesting. Overselling the milestone would
  make the tester feedback unreadable.

---

## ADR-037 — Plans can exist without a date, in a fourth GSI1 bucket

**Status:** Accepted · **Date:** 2026-08-07

**Context.** The model had three GSI1 buckets: `#S` for dated activities, `#N` for undated
ones, and `#R` for recurring series. That put every undated activity in one place, and the
  Today screen read `#N` into its undated-task group. The consequence, which nobody noticed until
the Plans tab was written out in full: `Dinner at Zahav with Alice and Ben, date TBD` — an
 agreed, shared, undecided plan — appeared in Today’s ANYTIME · NO DATE group, immediately below
`Submit the insurance form`.

Those two things are not the same kind of thing. One is an errand you will do at some point
today. The other is a plan waiting for somebody to pick a day, and putting it on Today either
nags the user about a decision they have not made or trains them to ignore the section.

**Decision.** A fourth GSI1 bucket, `#P` — "Needs a date" — holding undated Activities whose
explicit `objectKind` is `plan`. It is served by a new `GET /v1/plans` and rendered as the
first of the Plans tab's three stages. **The agenda never queries it**, which is a property
of the endpoint rather than a filter applied afterwards.

`#N` narrows to mean exactly one thing: an undated `objectKind: 'task'` Activity.

**Consequences.**
- The Plans tab becomes three stages — Needs a date, Upcoming, Past — and stops being a
  wider-window Today.
- An undated activity is a first-class stored thing with a place to be seen, so "save it now,
  decide later" is a supported path rather than a gap.
- One more bucket to keep correct on every write that changes a date, recurrence, or explicit
  `objectKind`. That risk is contained by ADR-038.
- Today’s ANYTIME · NO DATE group gets narrower and more honest. It holds undated errands.
- **Needs a date never nudges**: no badge, no count, no notification, no aging. It is a place
  to look, not a backlog to clear — the same rule that keeps Today from becoming a guilt
  list. The endpoint returns no count for a client to badge, which is the cheapest possible
  enforcement.

**Alternatives rejected.**
- *Keep one undated bucket and filter in the client.* The filter is the bucket rule written a
  second time, in the wrong layer, where no server test covers it.
- *Keep one bucket and let Today show everything undated.* This is the status quo and it is
  the defect.
- *A `needsDate` boolean on the Activity.* A second source of truth beside `schedule.date`
  and `objectKind`, which can disagree with both.
- *A separate `Plan` entity.* Rejected by ADR-011 and still rejected. A plan is an Activity
  with `objectKind: 'plan'`; the difference is one stored discriminator, not another table.

---

## ADR-038 — Bucket derivation is one pure function, and the rule reads explicit intent

**Status:** Accepted · **Date:** 2026-08-07

**Context.** Four buckets is one more than three, and the interesting question is not how many
there are but where the decision is made. A bucket rule spread across a repository, a schedule
service and a client renderer is a rule with three implementations that agree until they do
not. The Task-versus-Plan decision is already explicit, so the function must preserve it
rather than classify it again.

**Decision.** Exactly one pure function, `deriveGsi1Bucket`, in
`packages/shared/src/activities/bucket.ts`, with no I/O and its own test matrix:

```ts
if (a.recurrence)                                return 'R';
if (a.schedule?.date)                            return 'S';
if (a.objectKind === 'plan')                     return 'P';
return 'N';
```

Order is part of the specification. One caller — the function that builds an `ActivityIndex`
item. The bucket is recomputed and the index entry rewritten whenever one of its inputs
changes: a date is set or cleared, `objectKind` is explicitly changed, or recurrence is added
or removed. Participant and `type` writes are not inputs.

**The `objectKind` branch is the load-bearing part.** A private, undated Plan belongs in
Needs a date because the user called it a Plan, not because a classifier noticed its type.
 An undated Task belongs in ANYTIME · NO DATE. People, dates, and model output cannot silently move it
between those meanings.

**Consequences.**
- The rule is testable in isolation, at 100% branch coverage, with no database.
- Every transition that must trigger an index rewrite is enumerated, so a write path that
  forgets one is a missing test rather than a bug found by a user in the wrong tab.
- The client never names a bucket. It chooses `objectKind`; the server maps that stored intent
  to the index key.

**Alternatives rejected.**
- *Participants or type decide.* Both reinterpret other fields as intent and make the same
  title land differently after an unrelated edit.
- *A lookup table keyed by type.* It turns a presentation guide into a classifier and ignores
  the user's Task/Plan choice.
- *Let the client pass the bucket.* A client that can name its own index partition is a
  tenancy and correctness problem at once.

---

## ADR-039 — `lastActivityAt` is a separate field from `updatedAt`

**Status:** Accepted · **Date:** 2026-08-07

**Context.** The Needs-a-date stage has to be ordered. Oldest-first builds a queue with the
most ignored thing at the head, which is a backlog, and that stage is explicitly not one.
The useful order is most-recently-discussed: an RSVP, a posted update or an added expense
means people are talking about this plan, and it should float up.

The obvious implementation is to sort on `updatedAt`. `updatedAt` also backs `If-Match` on
`PATCH /v1/activities/:id`.

**Decision.** Two fields.

| Field | Bumped by | Read by |
| --- | --- | --- |
| `updatedAt` | Edits to the Activity itself | `If-Match`, and nothing else |
| `lastActivityAt` | RSVP changes, posted updates, added expenses | The `#P` bucket's sort key, and nothing else |

`lastActivityAt` is initialised to `createdAt`. An edit never bumps it; a discussion never
bumps `updatedAt`.

**Consequences.**
- A participant's RSVP cannot fail an owner's open edit sheet with a `409` about a change
  that touched none of the fields they were editing.
- The Needs-a-date list does not resort when somebody fixes a typo in a title.
- Every write path has to know which field it is bumping. A path that bumps both is wrong in
  a way that only appears under concurrent use, so the distinction is stated in the data
  model and tested in Phase 2 with an `If-Match` that must survive a `lastActivityAt` bump.
- Eight extra bytes per activity.

**Alternatives rejected.**
- *One timestamp.* Produces `409`s nobody can act on, and the honest fix — a three-way merge
  over fields that did not conflict — is real work to recover from a collision the model
  invented.
- *A version integer for `If-Match` and `updatedAt` for sorting.* Same problem in the other
  direction, plus a migration, plus a concurrency token that is not a timestamp and therefore
  reads as a different mechanism everywhere it appears.
- *Derive the order at read time from the newest `UPD#` item.* A query per row on the one
  screen that is a list of rows.

---

## ADR-040 — Changing a plan's date resets every RSVP, with no new enum value

**Status:** Accepted · **Date:** 2026-08-07

**Context.** Once a plan can exist without a date (ADR-037), people can respond to it before
a day is picked. When a date lands, their stored `going` is still there. Rendering that as
"Alice is going on Saturday" claims consent she never gave — she agreed to the idea of
Zahav, not to Saturday the 15th — in a product whose stated posture is *suggest, never
assume*.

The related question is vocabulary. `Going` is the wrong word for a plan with no date;
`Interested` is right. `Interested` looks like a fifth RSVP value.

**Decision.** Two rules, designed together.

1. **Setting or changing a plan's date resets every non-declined participant's `rsvp` to
   `pending`**, clears `respondedAt`, sets `rsvpForDate` to the new date, writes a system
   update and notifies. A **time-only** change on the same date keeps every response.
   Clearing a date keeps them too — re-asking somebody to un-agree is noise. The owner's own
   row is never reset. The response carries `rsvpReset: true` so the client says so rather
   than letting people discover it. *(Amended 2026-08-07: `declined` rows are excluded —
   neither reset nor notified, app user and guest alike. A declined participant left the
   conversation, and a date change is not an invitation; their route back is `Rejoin`. This
   supersedes the "partial rule" rejection below for the declined case only — `pending`,
   `going` and `maybe` still all reset. See phase-06 P6-15.)*
2. **The labels change with the same signal; the stored values never change.** `going` renders
   as `Interested` when there is no date and `Going` when there is; `declined` renders as
   `Pass` or `Decline`. **`interested` is not added to the enum.**

**Consequences.**
- `rsvpForDate` exists so a reset is provably correct rather than inferred, and so the client
  can render "Alice said yes to Saturday".
- The reschedule write grows by one `PART#` item per participant. At the 50-participant cap
  the transaction reaches 103 items, past DynamoDB's limit, so there is a threshold and a
  two-phase write above it with a marker that makes every read return `pending` in between.
  That machinery exists because of this rule and is recorded as a tension in
  `feature-to-schema-map.md` §11.
- Users lose responses when a date moves. That is the intent, and the confirmation before the
  write names how many people are affected — counting those who actually replied, so a plan
  nobody has answered shows no confirmation at all.
- Storing `interested` would have forced a data migration on the exact event that changes the
  word, which is the strongest possible argument against storing it.

**Alternatives rejected.**
- *Carry responses forward and notify.* Cheaper, and it puts words in somebody's mouth. The
  first time a user turns up to a Saturday they never agreed to, the product has lied about
  them to their friends.
- *Reset only for people who said `going`.* `maybe` to an undated idea is not `maybe` to a
  Saturday either, and the partial rule is harder to explain than the total one.
- *Add `interested` to the enum.* A migration every time somebody picks a date, for a word.
- *Ask the owner whether to reset.* A choice between "correct" and "convenient" offered at
  the moment the owner is least inclined to pick correct.

---

## ADR-041 — Lists are shareable, using the same People layer as plans

**Status:** Accepted · **Date:** 2026-08-07

**Context.** A grocery list in a household is used by more than one person. So is a packing
list for a trip that two people are taking, and a list of places to go on a weekend away.
Lists were single-owner, so the workaround was a screenshot or a second app.

The question was not whether to share lists but whether sharing them meant a second sharing
system: a second invite mechanism, a second identity model, a second set of authorisation
rules.

**Decision.** Lists are shareable **through the existing People layer**. A `ListMember` is
keyed by `personId`, the same `Person` rows that back plan participants; the share sheet is
the same participant picker with a different submit handler and a different cap; membership
uses the List pointer as its access grant. Confirming an app-user share creates or reuses the
member in the owner's People and the owner in the member's People, then writes an active
`PersonListLink` (`LLINK#`) on both sides. An accountless invite has only the owner-side
invited link until verified signup activates the reciprocal side. One sharing system, two
shareable objects.

Two roles (ADR-043), app users only (ADR-043), 20 people total including the owner and pending
invitations, and three concurrency rules —
checking is set not toggled, items sort by `(rank, itemId)`, duplicate titles are never
merged.

**Consequences.**
- No new invite token, no new public surface. **A list has no public projection at all**, so
  unlike a plan there is nothing a stranger can be shown and nothing to leak.
- The People page and Person view read active `LLINK#` rows for `sharedListCount` and Lists
  one of the two people explicitly shared with the other. The link is discovery/lifecycle
  data and never authorises list access; the `USER#/LIST#` pointer is still the only grant.
- Two non-owner co-members do not automatically become People. That would expose a list
  roster as a social graph without either person choosing it.
- List membership never changes `upcomingCount`, `lastActivityAt`, FREQUENT, RECENT or the
  relevance sort. An invited owner-side link is not displayed as already sharing a list.
- Duplicate-person merge and `GUESTEMAIL#` linking migrate and activate `ListMember` and
  `LLINK#` references as well as Plan references.
- The threat model gains a second multi-user object, which `security-privacy.md` §1 now names
  explicitly rather than implying.
- One new email template, because an invitee with no account has to be told.
  `01-product/notifications.md` §6.3 carries it as `list_invitation_email`, so SES now sends
  **four** messages, not three.
- A Plan/List relationship never changes List membership. Creation and attachment from Plan
  detail record provenance only; sharing stays an explicit, independent action on the List.

**Alternatives rejected.**
- *A separate list-sharing mechanism with its own tokens and links.* Two authorisation
  surfaces, two leak surfaces, two sets of tests, for the same underlying question.
- *Sharing a list by attaching it to a shared plan.* Ties a household grocery list to a plan
  that does not exist, and makes the list's membership a derived value that changes when
  somebody leaves the plan.
- *Not sharing lists in v1.* The grocery case is the single most common list in the product
  and it is the one most obviously wrong when only one person can hold it.

---

## ADR-042 — The canonical list moves to `LIST#`, and its index entries are near-pure pointers

**Status:** Accepted · **Date:** 2026-08-07

**Context.** The list lived at `USER#<owner>` / `LIST#<listId>`, with a mirror at
`LIST#<listId>` / `META` so it could be read by id. That is a sensible single-owner layout and
it does not survive a second member: whose partition holds the truth?

Separately, activity index entries carry denormalised display data — title, time, type — so
the Today feed renders from one query. The obvious move is to make list index entries match.

**Decision.** Two parts.

1. **The canonical list is `LIST#<listId>` / `META`.** The `USER#<u>` / `LIST#<listId>` rows
   are index entries, one for the owner and each active non-owner. Invited people have no
   pointer or access until verified signup. The mirror is gone; there is one copy.
2. **The list index entry carries `role` and `addedAt` and nothing else.** No title, no icon,
   no counts. The Lists tab is one `Query` for the pointers plus one `BatchGetItem` for the
   `META` rows.

Part 2 is deliberately **not** how `ActivityIndex` works, and the asymmetry is justified: an
activity feed is time-ranged and sorted, so its index must carry sortable denormalised data or
the feed needs a batch get per page. A user may own at most 100 Lists but may receive more
memberships from other owners, so the Lists index pages 50 pointers at a time and BatchGets
one page. It still needs no denormalised display fields.

**Consequences.**
- Renaming a shared list is **one write**, whoever makes it, however many members exist.
  With a denormalised title it would be one write per member.
- A grocery list two people are ticking through generates **no fan-out write per tick**.
- Each Lists-tab page costs one `BatchGetItem` for at most 50 current `META` rows.
- **The pointer is the access check.** Its absence is a `404`; its `role` is read without a
  second query. That is what makes an invited-but-not-joined member unable to read anything:
  there is no partition to write a pointer into, so there is nothing to find.
- A pointer that ever gains a title reintroduces both costs at once, so its attribute set is
  compared to a literal list in a test.
- The two index shapes differ, which someone will read as an inconsistency. It is written
  down in the data model, here, and in `feature-to-schema-map.md` §4.1 so the answer is
  findable.

**Alternatives rejected.**
- *Keep the canonical row in the owner's partition and add member pointers to it.* Every
  member's read goes through a partition they do not own, and deleting the owner's account
  raises the question of where the list lives.
- *Denormalise the title onto the pointer.* One write per member on every rename, and a
  fan-out on any field the tab renders. Saves one `BatchGetItem`.
- *Keep the mirror and write both.* Two writes on every list-level edit, forever, and a
  window where they disagree.

---

## ADR-043 — List membership is app users only, with two roles

**Status:** Accepted · **Date:** 2026-08-07

**Context.** Plans support guests: a person with no account can open an invite link, see the
plan and RSVP. The natural question is whether lists should work the same way — a link that
lets anybody add items.

Separately, the role model. Plans have owner and participant. Lists could have three roles —
owner, editor, viewer — or two.

**Decision.** Two rules.

1. **App users only.** There is no guest list editing and no public list link. An invitee
   with no account gets an email, installs, signs up, and the list appears, reusing the
   `GUESTEMAIL#` linking that already exists for guests. Until then their `ListMember` row has
   `status: 'invited'`, no `userId` and **no index entry**.
2. **Two roles.** `owner` can do everything including delete, member management and changing
   `behaviour`, `capabilities` and `slot`. `member` can add, edit, check, reorder and delete
   **items**, rename the list, and leave it. A member cannot change behaviour or capabilities
   — those drop typed fields from every item and are destructive under the interaction
   contract — and cannot delete the list or remove anyone but themselves.

The roles are access roles on `ListIndex`. The owner is represented by `List.ownerId` and an
owner pointer, never by a `MEMBER#` row. Every physical `ListMember` is a non-owner with fixed
role `member`; the roster API synthesises the owner first. Accordingly `memberCount` is one
plus the number of physical member rows, including invited rows.

Cap: **20 people total, including the owner and pending invitations**, lower than the 50 for a
plan. This is a household feature, not a broadcast one.

**Consequences.**
- Every item mutation has an identity to attribute it to, which is the reason the rule exists.
  An anonymous editor on a shared list is an item nobody can be asked about.
- A list has no public surface, so it has no projection to leak and needs no allow-list DTO,
  no token, no rate limiter and no `/public/v1` route. That is a real reduction in the attack
  surface compared with plans.
- An invited member can read **nothing** until they sign up, enforced structurally rather than
  by a status check: no pointer, so `404`.
- A read-only viewer is deferred, not designed. It is recorded in `00-open-decisions.md`.
- Adding a member is a small transaction — at most seven items including reciprocal People
  and `LLINK#` rows — so unlike participants there
  is no batching machinery and members are added one at a time.

**Alternatives rejected.**
- *Guest list editing via a token, like plan invites.* Every item write would be attributable
  only to a browser, the list would gain a public surface with a leak question attached, and
  a shared link would be a write capability handed to whoever forwards it.
- *Three roles with a viewer.* A third branch in every item route for a case nobody has
  asked for. Deferring it costs nothing; access roles are stored on the index pointer, so
  adding one later is additive.
- *A 50-member cap to match plans.* Fifty people editing one grocery list is not a use case,
  and the lower cap keeps the roster bounded and unpaginated.

---

## ADR-044 — No `If-Match` on list item writes

**Status:** Accepted · **Date:** 2026-08-07

**Context.** Every other mutable object in the product uses optimistic concurrency:
`PATCH /v1/activities/:id` carries `If-Match: <updatedAt>` and a mismatch is a `409`. Applying
the same rule to list items is the consistent choice.

It is also unusable. The dominant list operation is ticking a checkbox in a shop, often
offline, often while somebody else is ticking the same list. Under `If-Match`, every one of
those is a potential `409` about a change the user has no interest in and no way to resolve.

**Decision.** **Item writes carry no `If-Match`.** Last write wins on a field. **List-level
edits — title, capabilities, behaviour, slot — do carry `If-Match`**, because those are the
changes worth protecting and nobody makes them in a shop.

`checked` in particular is **set, never toggled**. `SET checked = NOT checked` is banned
outright: it reads identically in one client and flips the value back in two, and it breaks
the offline queue, where the same intent may be delivered twice.

**Consequences.**
- Two members checking the same item converge with no merge logic, no conflict banner and no
  `409`. The operation is idempotent and commutative, which is also what makes it safe to
  queue offline.
- Two members editing the same item's **title** in the same minute: one silently wins, with no
  signal to either. That is the honest cost and it is recorded as a tension rather than
  hidden. It is small because item titles are short, rarely edited, and trivially retyped.
- Two members inserting at the same position compute the **same** `lexoRank`, because the rank
  function is pure and neither knows about the other. Identical ranks are expected, not
  exceptional, and the total order `(rank, itemId)` resolves them identically on every device
  with no coordination. A comparator that sorts on `rank` alone leaves the outcome to engine
  sort stability.
- Two members adding the same title get two rows. **Never auto-merged** — silently swallowing
  somebody's entry is worse than a visible duplicate they can delete.
- Reordering is the one list operation that cannot be queued offline, because `afterItemId`
  is resolved against neighbours at flush time. It is refused with an explanation rather than
  queued and quietly misapplied.
- There is no CRDT. Web remains online-first/refetch-wins. Native reconciliation installs
  canonical responses and retained local work in an explicit SQLite sync transaction; it is
  not a generic item-set merge. Cases this policy handles badly are enumerated in
  `../03-implementation/phase-09-followup-and-launch.md` P9-08 rather than engineered around.
  Phase 6 may add a durable change feed/conflict policy if shared offline evidence requires it.

**Alternatives rejected.**
- *`If-Match` on everything.* Constant spurious `409`s on checkboxes, an offline queue that
  parks half a shopping trip in a conflict banner, and no benefit — the conflicting field is
  a boolean whose two writers agree.
- *`If-Match` on title but not on `checked`.* A per-field concurrency policy on one endpoint,
  which is harder to explain than either uniform rule and produces a `409` on a `PATCH` that
  happened to carry two fields.
- *A CRDT for list items.* A second storage engine on the client, a merge implementation the
  server does not share, and a class of bug that appears only with two devices at once — for
  a household grocery list.

---

## ADR-045 — Plan identity is explicit on Activity, not derived from a date, type, or people

**Status:** Accepted · **Date:** 2026-08-07

**Context.** ADR-011 first defined a Plan from `schedule.date`; ADR-037 then needed undated
Plans and derived them from `type` plus participants. Both rules let an unrelated edit change
what the object *is*: adding Alice to an undated Task moved it into Plans, and changing a type
could do the same. They also left no way to distinguish a private idea the user deliberately
made a Plan from a title the server happened to classify.

**Decision.**

> **A Plan is an Activity with `objectKind: 'plan'`, selected explicitly by the user or a
> labelled contextual entry point. A date changes scheduling state, not identity.**

That sentence is canonical in
[`data-model.md`](data-model.md#1-core-modelling-decision-there-is-only-one-schedulable-entity)
§1 and no document may say otherwise. `deriveGsi1Bucket` (ADR-038) is the mechanical
expression of it: an undated `plan` goes to `#P`, an undated `task` goes to `#N`, and a date
moves either to `#S` without changing `objectKind`.

Conversion is supported only as an explicit `PATCH /v1/activities/:id`. Task → Plan must
include `objectKind: 'plan'` and a Plan type the user selected. Plan → Task must include
`{ objectKind: 'task', type: 'task' }` and is allowed only when `participantCount`,
`expenseTotalCents`, and `childCount` are all zero. Otherwise the server returns
`409 conflict` naming every non-zero blocker and its current value. Text, date, type, and
participant edits never initiate either conversion.

**Consequences.**
- Scheduling is `POST /v1/activities/:id/schedule` rewriting one index entry. It does not
  promote a Task to a Plan or choose an object kind.
- Unscheduling is symmetric and lossless. The plan returns to Needs a date with its
  participants, updates, expenses and prep tasks intact, because none of them were attached
  to the date.
- The RSVP reset (ADR-040) is a consequence of a *scheduling state* change, not of an
  identity change — which is why responses are reset but everything else on the plan
  survives.
- Date suggestions (ADR-049) are coherent only under this rule. A dateless plan you can
  propose dates against is a plan; under the old definition it would have been a plan that
  did not exist yet.
- Copy follows the rule: the product says "needs a date", never "not yet a plan".
- Participant, type, text, and date mutations never rewrite `objectKind`. Only the guarded
  conversion request above changes it; the write then updates the canonical record and its
  index projection atomically.

**Alternatives rejected.**
- *Keep the date-based definition and call undated things something else.* That is a second
  noun in a product whose whole discipline is three, and it would need its own screen,
  vocabulary and conversion step.
- *Infer from participants and type.* Makes Plan identity a side effect and cannot represent
  a private Plan without treating every non-task type as one.
- *A separate `Plan` entity.* Adds a conversion and a second id where a discriminator on the
  one schedulable entity is enough.

---

## ADR-046 — Global Add and capture require an explicit creation target

**Status:** Accepted · **Date:** 2026-08-07

**Context.** A title-only request forced the server or model to decide whether a thought was
a Task, Plan, or ListItem and which Activity type it was. That is not harmless convenience:
it decides where the thought lives, whether it has a checkbox, and whether adding people is
appropriate. The same words can legitimately mean different things depending on the entry
point.

**Decision.** The client or labelled entry point chooses a `CreationTarget` before any create
or capture call:

```ts
type CreationTarget =
  | { objectKind: 'task'; type: 'task' }
  | { objectKind: 'plan'; type: PlanType }
  | { objectKind: 'listItem'; listId: string };
```

`PlanType = Exclude<ActivityType, 'task'>`, corresponding to the five visible Plan kinds:
General (`custom`), Meal, Watch, Event, and Outing. There is no invisible task-flavoured Plan.

`POST /v1/activities` requires `objectKind` and `type`; neither has a server default. A
ListItem is created only through its list-scoped endpoint. Capture receives the selected
target, echoes it, and returns only fields valid for it. It never returns a different target,
chooses participants, or writes anything. The complete contract and entry-point map are in
[`api-contract.md`](api-contract.md#23-activities) §2.3 and §2.11.

**Consequences.**
- Missing `objectKind` or `type` is `400 validation_failed`, not a hidden fallback.
- Global Add has three explicit outcomes: Task and Plan call `/v1/activities`; List item
  requires a chosen list and calls `/v1/lists/:id/items`.
- Contextual labels are target selection: `Add a task`, `Add prep task`, and `Add item` fix
  the target without another chooser. `Plan this item` fixes `objectKind: 'plan'` but still
  requires the caller-confirmed Plan kind and audience.
- AI can extract a date or location without deciding the user's organising intent. Text such
  as "with Alice" does not add Alice; sharing remains a separate confirmation.
- Idempotency is scoped to the final create endpoint, not to capture.

**Alternatives rejected.**
- *Default ambiguous input to Task.* Fast, but it silently answers the product's main
  organising question and makes a wrong destination look like user intent.
- *Let capture classify the target.* Produces the same hidden decision with a confidence
  score and makes the manual and AI paths disagree.
- *One generic create endpoint for all three targets.* Either accepts an invalid union of
  fields or branches on data the client could state directly; list access is clearer in the
  list-scoped route.

---

## ADR-047 — Reminders are per user, stored in the activity partition

**Status:** Accepted · **Date:** 2026-08-07

**Context.** `Activity` carried a `reminders[]` array. On a private activity that is correct.
On a shared plan it is a leak and a nuisance in one field: the creator's "leave in 15
minutes" is stored on the object everybody reads, so it either fires on everybody's phone or
is visible to everybody, and a participant who wants their own reminder has nowhere to put
it.

**Decision.** **`Activity.reminders[]` is removed.** A reminder is an item in the activity
partition keyed `REM#<userId>#<reminderId>`, per
[`data-model.md`](data-model.md#31-activity-partition) §3.1 and §4.3. A shared plan has **one
schedule and many reminder sets**. `GET`/`POST`/`DELETE /v1/activities/:id/reminders` operate
on the caller's own rows only
([`api-contract.md`](api-contract.md#24a-reminders--per-user) §2.4a).

**Consequences.**
- **One `Query` still serves both readers.** `pk = ACT#<a>` returns the whole plan; the detail
  handler filters `REM#` to the caller before responding (access pattern 4) and the reminder
  scheduler keeps all of them and fans out per user (access pattern 4b). No second index, no
  second query, no second code path.
- Keying on `userId` is symmetric with `PART#` and `EXP#`, so the partition has one shape
  rather than one shape plus an exception.
- Joining a shared plan creates the joiner's **own** row only from their own explicitly set
  `User.defaultReminderOffset`; `0` means At the time, while absent/null means Off. Nobody
  inherits anybody else's, and nobody is opted into a push they did not ask for.
- The Phase 5 reminder Lambda fans out per user rather than reading one array, and skips a
  user with no registered device without affecting anyone else's reminder.
- Leak vector: a detail response that forgets the filter shows one user a another user's
  reminder offset, which is a statement about their travel time and their day. It is in the
  threat model (`security-privacy.md` §1 row 15) with a test, not left to review.
- Cost: three endpoints and a filter, against a field that needed neither.

**Alternatives rejected.**
- *Keep `reminders[]` and tag each entry with a `userId`.* The whole array still ships to
  every reader of the activity, so the leak is unchanged and the filter has to happen at
  render time in every client. It also makes two users' concurrent reminder edits a
  read-modify-write on one item.
- *A separate `USER#<u>` / `REM#<activityId>` partition.* The detail screen becomes two
  queries and the scheduler needs a reverse index to find every reminder on one activity.
- *One reminder set per plan, owner-controlled.* That is the leak restated as a feature: the
  owner would be choosing when everyone else's phone buzzes.

---

## ADR-048 — Completion is global and owner-only

**Status:** Accepted · **Date:** 2026-08-07

**Context.** `Occurrence` carries no participant identity, so "completed" is a fact about the
thing, not about a person. The completion endpoints did not say who may assert that fact, and
one edge case in the Phase 2 plan said a participant could complete their own occurrence —
which the storage cannot represent.

**Decision.** **Only the owner may complete, skip, snooze or uncomplete**, and the result is
the same for everyone. Participants get `403`. The rule is canonical in
[`data-model.md`](data-model.md#45-occurrence) §4.5 and
[`api-contract.md`](api-contract.md#3-authorisation-rules) §3, and is enforced in the
authorisation middleware rather than per handler.

> **Amended by ADR-051.** This entry originally applied to every activity. It applies to
> **plans**; a prep task follows the shared-checklist rule and may be completed by any
> participant of its parent. The rest of this ADR is unchanged.

**Consequences.**
- An `Occurrence` says *the thing happened*. There is exactly one answer to "did the dinner
  happen", and it is the owner's.
- A participant who did not go sets their RSVP to `declined`; a participant who wants the
  plan off their day leaves it. Both already exist and both are honest.
- The agenda expansion never has to answer "whose occurrence is this?", so it stays one
  merge over one set of `OCC#` rows.
- Per-participant completion is a real feature with a real cost — `OCC#<date>#<userId>`, a
  per-caller expansion, and a completion state on every agenda row that means something
  different depending on who is reading. It is deferred, recorded in
  [`../00-open-decisions.md`](../00-open-decisions.md), not forgotten.
- A participant's `403` on `complete` is an acceptance test in Phase 2 and a row in the
  Phase 6 authorisation matrix.

**Alternatives rejected.**
- *Let a participant complete their own occurrence.* Unrepresentable without a per-user
  occurrence key, and the intermediate state — an activity that is completed for two people
  and pending for three — has no defined rendering.
- *Let any participant complete for everyone.* One person can then close a plan the owner is
  still expecting to happen, with no undo affordance for the owner.

---

## ADR-049 — Date suggestions: any participant proposes, only the owner schedules

**Status:** Accepted · **Date:** 2026-08-07

**Context.** ADR-037 gave undated plans a home. It did not give them a way to move. Needs a
date was therefore a holding area: the owner could schedule, and everybody else could wait.
The missing piece is small and specific — a participant needs to be able to say "how about
Thursday?" without being able to decide for everyone.

**Decision.** A `DateSuggestion` item at `SUGG#<isoTs>#<suggestionId>` in the activity
partition ([`data-model.md`](data-model.md#43a-datesuggestion) §4.3a).

- Any participant may add `{ date, time?, note? }`. **Max 5 per activity.**
- Others toggle themselves into `worksFor` — an availability signal, not a vote and not a
  like.
- **Only the owner schedules**, with `POST /v1/activities/:id/schedule { fromSuggestionId }`,
  which copies the date and time and then runs the ordinary scheduling path including the
  RSVP reset (ADR-040).
- All suggestions are deleted once the activity is scheduled.
- Guests on the public invite page cannot suggest. They read and RSVP.

**Consequences.**
- Needs a date becomes a planning surface rather than a queue, without acquiring a scheduling
  poll, a deadline, or a quorum rule.
- The cap of 5 is what keeps it a nudge. A plan with eleven candidate dates is a poll, and a
  poll needs closing rules, tie-breaks and a notification cadence this product does not want.
- `worksFor` is the only reaction-shaped thing in the product. It earns its place by being
  the actual coordination signal rather than sentiment.
- Scheduling from a suggestion still resets every RSVP, because the reset is about the date
  landing, not about where the date came from. Somebody marking a suggestion as workable has
  not agreed to attend.
- Suggestions are deleted rather than archived, so the plan detail has no stale "we
  considered Thursday" section and no second timeline beside the updates feed.
- It adds one sort-key prefix, four endpoints and five tasks in Phase 6. No new table, no new
  index, no new query.

**Alternatives rejected.**
- *Let any participant schedule.* One person picking the date for a plan somebody else owns
  is the same failure as ADR-048's, and it fires every participant's index-entry rewrite and
  RSVP reset.
- *A full availability poll — date grid, per-person yes/no/maybe, automatic winner.* A
  separate product. It needs closing rules and nagging, and Needs a date is explicitly
  allowed to nag nobody (ADR-037).
- *Suggestions as ordinary updates-feed entries.* No structure to toggle against, no cap, and
  no way to schedule from one without parsing prose.
- *Keeping suggestions after scheduling, for history.* A record of dates that did not happen,
  shown on every future read of the plan, for no decision anybody will make again.

---

## ADR-050 — No date ranges in v1

**Status:** Accepted · **Date:** 2026-08-07

**Context.** A weekend trip, a three-day festival and a week away are all obvious things to
put in a planner, and `schedule.endDate` is an obvious field to add. It was proposed, deferred
before Phase 0 (open decision 8), and re-litigated in the review of 2026-08-07.

**Decision.** **Upheld. `schedule` has a `date` and never an `endDate` in v1.** A multi-day
trip is **one activity on its start date**, with prep tasks and lists hanging off it.

The consequence is stated rather than designed around: **the trip does not appear on Today on
days two and three.** No v1 screen, example, mock or fixture may show a date range.

**Consequences.**
- The agenda stays one `BETWEEN` query on `gsi1sk`. Ranges would need either an index entry
  per day of the range — a fan-out on every reschedule, multiplied by every participant — or
  a second query on every agenda read for activities that straddle the window. Both are paid
  on every request by every user, for a feature a minority need.
- `.ics` export keeps one `DTSTART`/`DTEND` pair derived from one date, and the recurrence
  expansion has one nominal date per occurrence to key `OCC#` rows against.
- `Recurrence.endDate` is unaffected and stays. It terminates a *series*; it does not give one
  occurrence a duration. Do not confuse the two fields when reading the schema.
- Someone planning a three-day trip sees it on Today on day one and finds it under the trip's
  own detail screen thereafter. The prep tasks, which are the things with dates, are on the
  days they belong to.
- The upgrade path is additive when it arrives: `endDate` plus a second index entry per day,
  behind a real request.

**Alternatives rejected.**
- *`schedule.endDate` with a straddling query on every agenda read.* A second query on the
  most-hit endpoint in the product, permanently, to serve a case nobody has yet complained
  about.
- *One index entry per day of the range.* Bounded only by the range length, rewritten on every
  reschedule, fanned out across every participant. A two-week holiday becomes 14 entries per
  person.
- *A parent activity with one child per day.* Fourteen rows the user did not create, each
  completable independently, and a deletion cascade to design. It contradicts "suggest, never
  auto-create".
- *Rendering the range on the client from a duration field.* The client would show the trip on
  day two while the server's agenda does not return it, so Today and Plans would disagree
  about the same activity.

---

## ADR-051 — Completion authority follows the object: a prep task is not a plan

**Status:** Accepted · **Date:** 2026-08-07 · **Amends:** ADR-048

**Context.** ADR-048 made completion global and owner-only, which is right for a plan. It was
then read as covering prep tasks too, on the argument that a prep task is its own Activity
whose `ownerId` belongs to whoever typed it, so the ordinary owner check already let a
participant tick the ones they added and no participant branch was needed. That argument does
not hold. A prep task created inside somebody else's shared plan is usually owned by the plan
owner, and the case the product actually wants is the opposite one: Alice books the hotel for
a trip we are planning together and ticks `Book hotel` whether or not she typed it.

**Decision.** Completion authority follows the object.

- Completing a **plan** asserts a shared fact about an event — it happened or it did not —
  so **only the owner** may complete, skip, snooze or uncomplete it. ADR-048, unchanged.
- Completing a **prep task** ticks an item on a shared checklist, so **any participant of the
  parent plan may complete, uncomplete and edit it, whoever created it**.

This is the consistent reading rather than a special case: a prep task behaves like an item
on a shared list, and in both places a collaborator may check a shared checklist item.

It costs **one rule in `authz.ts`** — *a participant of the parent may act on a child* —
applied once in the middleware, not per endpoint. When the loaded activity carries a
`parentActivityId`, the check also consults the **parent's** `PART#` rows. Canonical in
[`api-contract.md`](api-contract.md#3-authorisation-rules) §3.

**Consequences.**
- One extra `GetItem` — the parent's `PART#<personId>` row — on an authorised call to a child
  activity, or a cached parent lookup where the handler already holds the parent. It fires
  only when `parentActivityId` is present.
- `parentActivityId` is read from the **stored** child item, never from the request, so a
  caller cannot name a parent to borrow its permissions
  ([`security-privacy.md`](security-privacy.md#1-threat-model) row 1a).
- Nesting is capped at two levels
  ([`../01-product/plans-and-lists.md`](../01-product/plans-and-lists.md#3-prep-tasks) §3), so
  the walk is one hop and cannot recurse.
- Three test cases, in Phase 2 (P2-13) and walked with real participants in Phase 6 (P6-28):
  the child's owner, a participant of the parent who did not create the child, and a stranger
  getting `404`.
- Nothing about `Occurrence` changes. There is still no participant identity on a completion,
  and per-participant completion of a *plan* stays deferred
  ([`../00-open-decisions.md`](../00-open-decisions.md) item 31).

**Alternatives rejected.**
- *Keep the owner-only reading for prep tasks.* It makes the plan owner a bottleneck on the
  exact work a shared plan exists to divide, and it depends on a claim about `ownerId` that
  is false for prep tasks added inside somebody else's plan.
- *Only the creator of a prep task may complete it.* The same bottleneck, one person smaller,
  and it means a checklist item nobody can tick once its author leaves the plan.
- *Grant it per endpoint rather than in the middleware.* Six handlers each deciding what a
  parent means is how authorisation rules drift apart.

---

## ADR-052 — Merge the Outing Plan kind into Event

**Status:** Accepted · **Date:** 2026-08-09

**Context.** Event and Outing had identical scheduling, sharing, completion, list-bridge and
detail behaviour. Their differentiating fields were thin and mutually optional: Event held
ticket details, while Outing held a place name and reservation. In practice the place already
lived in `location.label`, and either kind could represent the same dinner, appointment,
festival, hike or reservation. The fifth chooser row imposed a decision without buying a
meaningful behavioural boundary.

**Decision.** Merge Outing into Event. The stored `outing` enum member and details-union arm
are removed. Event keeps the `map-pin` glyph, takes the rosewood accent, and owns the combined
ticket, organiser, description and reservation fields. `placeName` is retired in favour of
`location.label`. Existing Phase-1 fixtures are retrofitted before any production migration
is needed.

**Consequences.**
- Plans have four visible kinds: General, Meal, Watch and Event.
- Leaving Event is destructive when ticket, organiser or reservation data is populated; the
  confirmation names each reservation field that would be removed.
- Event subtitles use organiser first, then the location label.
- A completed Event is evidence for `Mark visited?` only when it was bridged from a checkable
  list in the `places` slot.
- The chooser loses one row and the data model loses one discriminator without losing any
  field a user could previously record.

**Alternatives rejected.**
- *Keep both kinds and cross-populate their fields.* The forms become identical while the
  chooser still asks the user to distinguish them.
- *Keep Outing and retire Event.* Event is the broader everyday noun and already owns the
  public description, ticket and organiser projection.
- *Introduce a new umbrella kind.* A migration and a fifth label to solve the cost of a fifth
  label.

---

## Open questions

Genuinely undecided. Each needs a decision before the phase named.

| # | Question | Needed by | Notes |
| --- | --- | --- | --- |
| OQ-1 | Should media move to CloudFront **signed URLs**? | Phase 7 | ADR-023 accepts unguessable keys for now. If users start attaching documents, receipts, or anything with a face in it that they would not share, signed URLs become worth the key management. Decide after seeing what people actually upload. |
| OQ-2 | Can the GitHub deploy roles be scoped **per stack prefix** at the CDK bootstrap level? | Phase 5 | The prod stacks a dev role could reach do not exist until Phase 5, and the deploy roles themselves are not created until Phase 4 (P4-06). Today the stage separation relies on the GitHub `production` environment approval gate. CDK's bootstrap roles are account-wide, so `od-github-deploy-dev` could in principle assume a role that touches prod stacks. Investigate per-stack deploy roles or a policy condition on the CloudFormation stack name. |
| OQ-5 | Which **model** and which **provider** for Phase 8 capture? | Phase 8 | ADR-008 defers this behind a `CaptureProvider` interface. The decision needs a real accuracy evaluation against a corpus of actual posters and screenshots, plus current pricing, plus written confirmation that API inputs are excluded from training. |
| OQ-6 | Is there a **paid tier**, and does capture sit behind it? | Phase 8 | `cost-model.md` §3.4 projects model spend at roughly 35× the AWS bill at 1,000 users. Unlimited free capture does not work economically. A free monthly quota with paid capture above it probably does. This is a product decision, not a technical one. |
| OQ-7 | When does **prod move to its own AWS account**? | When a second person gets access | ADR-010 accepts one account for now and states the trigger. The migration path (bootstrap the new account, export/import the table, cut DNS over) should be written down before it is needed. |
| OQ-8 | Does the **web build need web push**? | Phase 7 | Currently a no-op stub. Requires a service worker, VAPID keys, and a separate permission model, none of which Expo abstracts. Only worth it if web turns out to be a primary surface rather than the invite-page surface. |

---

## Resolved questions

Recorded here rather than deleted, so a reader who remembers the question can find the
answer and where it was made.

| # | Question | Resolved in | Resolution |
| --- | --- | --- | --- |
| OQ-3 | What is the **Lambda memory setting** that actually minimises cost and latency? | `03-implementation/phase-05-ship-v1.md` P5-33 and `phase-09-followup-and-launch.md` P9-15 | Phase 5 runs a synthetic power-tuning curve to choose the safe launch setting. Phase 9 repeats the same 512/768/1024/1536/2048 MB comparison against representative real traffic, records the final curve in `docs/05-operations/perf/lambda-power-tuning.md`, and may revise `memorySize`. Measuring twice is deliberate: launch baseline first, production closure second. |
| OQ-4 | Does **refresh token rotation** need a CDK escape hatch? | `03-implementation/phase-04-deploy-and-identity.md` P4-09 | Check the CDK version in the lockfile; if the `UserPoolClient` L2 has no property, use the `CfnUserPoolClient` escape hatch in `auth.md` §1.6 with a 60-second retry grace period. Rotation is not optional. |
| OQ-9 | What is the **guest-email lookup partition**? | `03-implementation/phase-06-sharing.md` P6-27 | `GUESTEMAIL#<lowercased-email>` is now in `data-model.md` §3.4 with access pattern 14b. |
| OQ-10 | Do the three **web auth endpoints** belong on the public prefix? | `03-implementation/phase-04-deploy-and-identity.md` P4-18 | Yes, on `/public/v1/auth/*`, with their own limit of 10 req/min per IP and an additional 60/hour per IP on `/refresh`. Recorded in `api-contract.md` §2.0. |
| OQ-11 | Is `zod` v4 viable, or does `zod-to-openapi` pin us to v3? | `03-implementation/phase-00-foundations.md` P0-07 | **Closed 2026-08-08 in P0-07: v4.** The premise expired — `@asteasolutions/zod-to-openapi@9` declares a peer dependency of `zod@^4.0.0`, so v4 is not merely viable, it is what the current generator supports and v3 is the version that would need pinning. `@hono/zod-validator@0.9` accepts `^3.25.0 \|\| ^4.0.0`, so the API side is unconstrained either way. `packages/shared` pins `zod@4.4.3`; `tech-stack.md` §2.2 carries the range. Revisit only if P0-25 finds the generator unusable, which would be a change of generator, not of zod. |
| OQ-12 | Does **`.ics` generation** need a library, and which one? | `03-implementation/phase-06-sharing.md` P6-08 | No library. A typed builder in `packages/shared/src/ics/` with its own escaping, 75-octet folding, golden files and a parser-oracle test. |

---

## ADR-053 — Activity scope is explicit, never an optional `occurrenceDate` at a write site

**Status:** Accepted · **Date:** 2026-08-13

**Context.** Scope travelled as an optional `occurrenceDate?: string` — 184 references across
30 non-test files — and its absence carried two meanings that nothing distinguished. On a
one-off it means "not applicable", which is correct. On a recurring activity it means
"operate on the whole series", which sets `status` on `ACT#/META` and, because
`agendaService`'s `mergeNominal` renders an occurrence with no override using
`entry.activity.status`, repaints **every** un-overridden occurrence as completed.
Distinguishing the two required knowing whether the activity recurs, which most call sites did
not have to hand.

Twelve of the fifteen recurrence defects found on 2026-08-13 were that one shape: the Today
checkbox, `applyCreate`, the detail screen's series-anchor fallback, the occurrence
reschedule's duplicate row, `complete` and `skip` on the API, and the rest. None was found by
the suite, which was green throughout at ~2,790 tests — unit fixtures inherit the same
ambiguity, and two of them encoded states that cannot exist.

An optional field whose omitted case is the destructive one is an API designed backwards.
Forgetting should fail to compile, not escalate.

**Decision.** `ActivityScope` in `packages/shared/src/types/scope.ts` is a discriminated union
with no absent case:

```ts
type ActivityScope = { kind: 'activity' } | { kind: 'occurrence'; date: string };
```

A caller states which it means or does not compile, so activity scope is a decision rather
than an omission. `targetsWholeSeries(recurs, scope)` states the condition every guard was
missing, once. `scopeForRow` is the sole place an agenda row's scope is decided; the agenda
hook previously held seven hand-rolled versions in three spellings, one of which spread
`occurrenceDate: undefined` for a recurring row rather than omitting the key.

**The wire is deliberately unchanged.** `occurrenceDate?` appears eleven times in
`docs/generated/openapi.json` across the five inputs, `AgendaItem` and
`ActivityCompletionResult`. The ambiguity lives in the code, not the protocol, so
`scopeToWire`/`scopeFromWire` convert at the boundary and `pnpm gen:openapi` produces no diff.

**Persisted mutation variables are unchanged for a sharper reason.** `persister.ts` dehydrates
paused mutations on iOS *with their variables* under a single `CACHE_BUSTER`. A changed
variable shape would replay a body it never meant, and the only alternative — bumping the
buster — discards every queued offline write.

**Consequences.** The union removes *accidental* absence, not all absence: every one-off uses
activity scope, and `uncomplete` accepts it even on a series (see below). The rule is therefore
per-operation and lives in `assertOccurrenceScoped`, not in the type.

The union only protects call sites that use it, so `scopeGuard.test.ts` ratchets the file list
allowed to name the wire key and forbids the client write layer from building it by hand.

Converted so far: the mobile write sites and the API completion guard. **Not yet converted:**
the agenda projectors in `lib/agendaCache.ts` and the `apply*` models, and the detail screen's
own `occurrenceDate?: string` props. Those are mechanical follow-ups, and the ratchet stops the
list growing meanwhile.

**Alternatives rejected.** Changing the wire to a nested `scope` object — breaking, for a
problem that is not in the protocol. Separate scope types per operation, so the type could
carry the `uncomplete` exception — worse than one honest guard, and it multiplies the
vocabulary for a single exception with a scheduled end.

---

## ADR-054 — Does not repeat, No end and End series are three operations

**Status:** Accepted · **Date:** 2026-08-14

**Context.** The Repeat sheet used `Never` for two opposite ideas. In one description it
removed `recurrence`, converting a series to a one-off and making stored occurrence history
unreachable. In another it set `recurrence.endDate`, preserving the series and its history.
The Ends control also used `Never` to mean the series had no termination. Code and tests could
therefore agree on a label while performing different writes. The 2026-08-13 attempt to make
Repeat → Never an alias for End series removed the ambiguity by discarding the conversion,
but the founder confirmed on 2026-08-14 that conversion is required and is distinct.

**Decision.** The product has three named operations:

1. **Does not repeat** removes `recurrence`. On an existing series it requires an explicit
   occurrence target. That occurrence's effective date, time and end time become the one-off
   Activity schedule, with the Activity timezone retained.
2. **End series** preserves `recurrence` and sets an explicit inclusive `endDate`.
3. **No end** is the Ends value that clears `endDate` and `count`; it means indefinite
   recurrence.

An existing series cannot be converted from activity-only detail because the server cannot
choose which virtual occurrence survives. The client may not guess today, next or most recent
from its agenda cache. Navigation from an occurrence supplies the nominal date, and the server
resolves its effective schedule authoritatively against the recurrence segment and occurrence
override. Existing `OCC#` rows remain stored after conversion but no longer render; when
completed history will disappear from view, confirmation names the actual count and offers
End series as the history-preserving alternative.

**Consequences.** Phase 2.5 is a blocking gate before the rest of Phase 2 and Phase 3. P2-52
records this contract; P2-53 supplies explicit detail targets and authoritative projection;
P2-54 implements atomic conversion, distinct ending writes and versioned agenda
reconciliation; P2-55 proves the cross-layer matrix and audits series damaged by earlier
scope errors. The temporary `Never` UI remains unchanged until P2-54 can change copy and
behavior together; it must not be relabelled while still invoking the old write.

**Alternatives rejected.** Keep one `Never` label and infer meaning from which control it
appears in — the existing failure mode. Make conversion retain `schedule.date` — wrong when
the user selected a moved or later occurrence. Pick an occurrence from cached agenda data —
nondeterministic across cold start, request windows and timezone changes. Delete stored
occurrence rows on conversion — destructive work with no benefit and no recovery path.

---

## ADR-055 — The durable intent log and client-minted canonical ids

**Status:** Accepted · **Date:** 2026-08-17 · **Amends ADR-024**

> **Amended by ADR-057 (2026-08-18).** The semantics stand — client-minted canonical ULIDs,
> the never-age-expired durable log written before acceptance, tombstone-checked creation
> and the shared retention constant. Their native storage and materialization move from the
> AsyncStorage intent log and TanStack cache to SQLite outbox transactions; P2-62 ports
> them without semantic change.

**Context.** ADR-024's three mechanisms left the durability boundary at TanStack Query's
persisted mutation cache, which the 2026-08-13 review showed shares the query cache's
envelope: a cache-buster bump, a seven-day age check, or a slow storage restore each
silently destroys queued user writes. Separately, `interaction-contract.md` §5.4's promised
`Pending` indicator and offline bar were never built, and offline *creation* had no design
at all — the client cannot show a row the server has not yet named. An earlier draft
resolved that with temporary ids reconciled after sync; `data-model.md` §8's own rationale
("no coordination needed") makes the reconciliation layer unnecessary.

**Decision.** A fourth mechanism joins ADR-024's three, specified in `tech-stack.md` §3.4:
a **durable intent log** — account-scoped, separately keyed and versioned, never
age-expired, written before the action is reported accepted — with **client-minted canonical
ULIDs** for `act_` and `rem_`, conditional server creation checked against a deletion
tombstone whose lifetime shares `MAX_AUTOMATIC_INTENT_AGE_DAYS` with the client's bounded
automatic replay. Pending entities are visible, inert and cancellable. TanStack remains the
execution machinery; it stops being the durability boundary.

**What ADR-024 keeps.** Everything else, explicitly including the web rule: the mutation
queue — and therefore the intent log — is iOS-only, because a browser tab is closed rather
than backgrounded and a queue that never flushes is worse than an error toast. The scope
guard also stands: the log is a write-ahead record of intents, not a replica; the reminder
projection (P2-57) is a bounded derived projection for one device capability, expanded
locally only for entities the server has never seen.

**Consequences.** Offline creation becomes safe to build (Phase 2.6) and Phase 3's queued
list-item promises inherit a real foundation; sign-out gains a quarantine step (`auth.md`
§3.4); deletion writes a tombstone; `POST /v1/activities` accepts an optional client id; and
two windows that must never be tuned apart are one shared constant. On iOS the log session is
the sole replay owner: legacy paused mutations are imported and retired before connectivity,
claims are atomic no-ops when already owned, and overlapping replay requests coalesce into one
serial drain.

**Alternatives rejected.** Temporary ids with canonicalization — rebuilt coordination that
ULIDs exist to avoid, and required id rewriting inside queued mutations. Making the
TanStack persisted cache the durable store with a longer TTL — retention is not the defect;
sharing a disposal policy with a cache is. Extending the log to web — rejected for
ADR-024's original reason. Unbounded automatic replay — a create surfacing months later
without confirmation, and an account-lifetime tombstone obligation, for no user benefit.

---

## ADR-056 — Durable action state, dependent intents and level-triggered replay

**Status:** Accepted · **Date:** 2026-08-18 · **Amends ADR-055**

> **Amended by ADR-057 (2026-08-18).** The semantics stand — the four persisted states with
> coordinator-only `refused`, structured attention, durable dependent inverses, receipts,
> per-entity barriers and level-triggered replay. Their native storage and materialization
> move to the SQLite outbox; P2-62 ports them without semantic change.

**Context.** ADR-055 made the intent log the write-ahead durability boundary, but its first
implementation still exposed a TanStack mutation promise as the semantic result to legacy UI
helpers. A transient offline rejection therefore rolled back an action that the log had
already accepted and queued. Undo also existed only as an in-memory decision to issue a
second request: process death, a claim race, or a lost original response could lose or
misorder the inverse. Replay coalesced concurrent calls but still depended primarily on a
connectivity edge and did not stop a later same-entity intent after its predecessor requeued.

**Decision.** Persisted intent schema v2 has exactly four states:
`queued | in_flight | acknowledged | needs_attention`. `refused` is a coordinator-only
result when durable append fails and is never persisted. `needs_attention` is structured as
either `rejected` (permanent server status/code/details) or `parked` with an enumerated cause;
display-only `lastError` is never parsed for behavior. Stable unique intent ids make append
idempotent for canonically equivalent payloads and an invariant failure for conflicting
reuse; v1 migration preserves every distinct write and deterministically repairs legacy
duplicate ids.

An observable `DurableAction` is the UI contract. It reports durable state and exposes a
durable `undo()`. A queued original is cancelled atomically with its projection. Once claimed,
Undo appends an inverse intent dependent on the original. Non-acknowledged dependencies block;
acknowledgement permits dispatch. Lightweight acknowledged receipts remain while dependents
or recurrence reconciliation require them, and compact only after they do not. Missing
dependencies never imply success. Response-loss ambiguity is resolved through the original's
authoritative recovery/idempotency path before the inverse is retired or executed.

Replay remains globally serial initially and enforces a per-entity barrier: a requeued or
attention-requiring N blocks N+1 for that entity while another entity may progress. Enqueue,
transient backoff, foreground and reconnect request bounded/coalesced single-flight drains;
the system is level-triggered and needs neither a fixed polling loop nor a false→true
connectivity edge. TanStack remains request/cache machinery, not the authority for acceptance.

**Consequences.** `startUndoable` becomes presentation-only: transient request failure keeps
the accepted projection and shows queued state; rollback occurs only for refusal or known
permanent rejection. PATCH/delete settlement can no longer identify a logical write with a
fresh `Date.now()`. The recurrence-edit receipt introduced immediately before this ADR is a
specialized consumer of the same acknowledged-receipt rule and remains retained until strong
targeted agenda reconciliation proves the canonical projection.

**Measured exception.** P2-59 does not change reachability policy. The local five-second
health timeout must be instrumented or reproduced before probe decoupling; agenda latency by
itself is not evidence that the probe failed.

**Alternatives rejected.** Treating every rejected promise as failure — contradicts a durable
queued record. Holding Undo until the toast expires — closing the app loses the action.
Executing inverses without dependencies — can invert an original the server never accepted.
A fixed replay loop — drains battery and invites a reconnect herd. Cross-entity parallel
dispatch now — optional throughput work with no correctness benefit over the simpler serial
owner.

---

## ADR-057 — SQLite materialized native state and a transactional outbox

**Status:** Accepted · **Date:** 2026-08-18 · **Amends ADR-024, ADR-055 and ADR-056;
supersedes P2-60's native read-time materializer**

**Context.** P2-59 made durable acceptance, dependent Undo and replay ordering correct, but
native visible state still had two authorities: TanStack/AsyncStorage responses and durable
intents folded into them. P2-60 specified `base ⊕ intents` on every read and a 637-line
`durableOverlay.ts` experiment. Real-device offline/online testing retained flicker,
cross-screen disagreement and destructive refresh edges because hydration, reads, overlay
folding and settlement could still become observable in different orders. P2-60 remains
historical evidence and fixes the acceptance bar — no visual replay, no stale refetch
regression, identical state after restart, no screen disagreement and no empty Today during
failed refresh — but its runtime commits do not join the production lineage.

**Decision.** After a native feature is migrated, SQLite is its sole source of visible
domain state. Native screens read and subscribe to typed repositories only. They never merge
TanStack responses with outbox intents during render or read. Materialization happens in
local-action and sync transactions, so UI reads are ordinary queries over already-
materialized rows.

A locally accepted offline-capable action is one SQLite transaction: append its durable
outbox intent, update every affected visible row, then commit. Append or transaction failure
returns coordinator-only `refused`, sends no request and exposes no accepted state. P2-59's
semantics remain invariants of the SQLite outbox: stable mutation ids, idempotent equivalent
append, structured `needs_attention/rejected|parked`, durable dependent inverse intents,
explicit per-`ordering_key` barriers, receipts while dependencies or reconciliation need
them, and bounded level-triggered replay.

Tables are domain-specific. Query, render and order fields use typed/indexed columns; nested
opaque fields may be JSON. A verified server snapshot/version may be retained for rollback or
rebase. This decision does not freeze a generic `base_json`/`view_json` entity table, mirror
DynamoDB `PK`/`SK`/GSI shapes, require an ORM, or adopt a generic local-first framework.

One serialized native sync engine owns network writes and reconciliation. It claims intents,
observes explicit `ordering_key` domains, calls existing API endpoints, transactionally
installs canonical write/read responses and rematerialized rows, then retires or parks
intents. A blocked ordering key cannot be overtaken; unrelated work may progress. Cross-
entity concurrent dispatch is not required. TanStack may remain HTTP/request machinery, but
it is neither native domain state nor native persistence after cutover.

Connectivity, foreground and manual refresh only schedule bounded sync work. Pull-to-refresh
means `syncNow()`. A failed pull retains committed rows and records a retryable sync error;
connectivity never clears, reconstructs or directly changes visible rows. A stale response
cannot replace a row whose stored canonical/local version proves it older.

**Server authority and recurrence.** DynamoDB/API remain authoritative for ownership,
versions, capabilities, derived fields, occurrence history, existing-series recurrence
expansion and completion-relative recurrence. The native database is an application model,
not a DynamoDB mirror.

- Recurring CREATE may expand across known local coverage because its first segment came
  from this client.
- A one-occurrence edit may update its explicit row locally.
- An existing-series recurrence edit retains prior canonical agenda rows with queued/updating
  state; it never locally invents the new expansion.
- After PATCH acknowledgement, the existing targeted strong activity-agenda read atomically
  replaces only that activity's rows, including an authoritative result of zero rows.
- A failed targeted read retains those rows and exposes Retry.
- Completion-relative recurrence projects no next occurrence locally; the server response
  reconciles it in Phase 9.

**Platforms and later phases.** This migration is native/iOS only. Web keeps the existing
online-first TanStack adapter and no durable mutation queue. Shared repository and use-case
interfaces keep domain/UI behavior common without making SQLite a web dependency. Phase 3
Lists/ListItems use typed SQLite repositories and the same transaction/outbox boundary;
reminders derive from committed rows; Phase 8 confirmed AI actions use the same coordinator.

**Account isolation and migration.** Each immutable account namespace owns one SQLite
database with a hashed filename and an owner assertion in metadata. Sign-out closes and
quarantines it; a different account opens a different file; confirmed account deletion
purges it. A database containing unresolved outbox work is never deleted merely because of
age.

Legacy AsyncStorage migration is idempotent and transactional. It imports only verified
server-base cache data plus every distinct intent, status and dependency; reads back and
verifies the result; persists a migration receipt; then retires legacy data. A P2-60
materialized overlay is never imported as canonical base. Ambiguous cache provenance keeps
the intents and requires sync instead of guessing.

**Convergence without a change feed.** Phase 2.6 does not require a generic server change-
feed/cursor. Existing collection/detail endpoints, coverage-aware foreground/manual pulls,
canonical write responses, tombstones and the targeted recurrence read are sufficient for
the single-user native slice. Sync interfaces remain extensible so Phase 6 collaboration may
add a durable change feed and conflict policy when shared offline edits require them.

**Consequences.** Native reads become fast and deterministic at the cost of versioned local
schema migrations, explicit materializers and an account-database lifecycle. The production
gate is split into P2-61 (foundation), P2-62 (Activity/Agenda vertical slice) and P2-63
(convergence and legacy retirement); Phase 3 begins only after P2-63. ADR-024 remains the web
policy. ADR-055's client-minted identity and retention rules and ADR-056's durable action,
dependency and replay rules survive, but their native AsyncStorage/TanStack materialization
is replaced by SQLite transactions.

**Implementation note (2026-08-19).** P2-63 removed the native intent-log/MutationCache
replay owner and native Activity/Agenda query-domain hydration. Typed endpoint adapters now
feed one serialized SQLite sync engine. Legacy account logs and query-domain records are
retired only after separate verified SQLite receipts; unproven query provenance is recorded
as ambiguous and requires synchronization. A failed verification defers retirement without
blocking the SQLite session, while native query-cache persistence stays disabled so it cannot
overwrite the retained source. Domain-specific Activity
and reminder tombstones, projection-version guards and the strong targeted recurrence
transaction close the convergence paths without adding a change feed. Web remains on the
online-first TanStack adapter.

**Alternatives rejected.** P2-60's generic read-time overlay — two authorities remain
observable. A generic entity table — hides query contracts and turns JSON rewriting into the
storage API. A DynamoDB mirror — couples device schema to server access paths. CRDTs or a
generic local-first framework — no Phase 2.6 conflict model requires them. A new change feed
as a prerequisite — existing single-user contracts converge without it. SQLite on web — the
browser has different lifecycle constraints and no durable mutation queue. Local expansion
of server-known recurrence — duplicates the server's authoritative occurrence rules.

---

## ADR-058 — One List model with intrinsic state and keyed typed features

**Status:** Accepted · **Date:** 2026-08-28 · **Supersedes ADR-031; amends ADR-032, ADR-033,
ADR-043 and ADR-044**

**Context.** ADR-031 correctly rejected a growing enum of purposes, but its replacement still
made optional Watch progress and Meal ingredients into whole-List behaviours. That boundary
promised every item had the same typed detail, made a settings change an aggregate rewrite and
forced the renderer, API and offline intent log through three parallel branches. In practice
episode progress is optional even on a Watch list, Place is independently useful, and a small
ranked child collection is useful with vocabulary other than Ingredients.

**Decision.** Store one schema-v2 `List` and one `ListItem`. Every item owns intrinsic
`open | active | done` state. The List stores an `ItemStateMode` (`none`, `checkbox`, or labelled
stages) and a keyed `featureConfig` for Progress, Place and Sub-items. Item values remain typed.
Disabling a feature or changing state presentation hides behavior without rewriting or deleting
values. Sub-item display labels are independent of the explicit optional `mealIngredients`
integration; no adapter inspects words.

Creation uses exactly seven ordered presets: Blank, Checklist, Groceries, Watch Later, Books to
Read, Places to Visit and Meal Ideas. A preset is copied once and `templateKey` remains immutable
provenance. Plan kind stays explicit and chooses a one-time copy adapter over the compatible
enabled intersection. Slots remain independent semantic routing declarations.

Legacy aggregates are converted losslessly and deterministically to schema v2. Server conversion
uses one resumable aggregate gate; SQLite converts committed projections plus pending/outbox
intent meaning transactionally. The old behaviour-change endpoint, destructive preview model,
work marker and current public discriminator are removed after compatibility translation.

**Consequences.** The common item shell and a small renderer/editor registry replace screen
branches. Mode/feature settings are immediate, reversible and never destructive. Every writer
maintains `doneCount`; checkbox bulk operations project `done` as checked and set explicit states
rather than toggling. Typed additions require a configuration/value pair and registry entry,
plus an adapter only when a cross-entity copy is justified. Adding a second List entity or a new
purpose enum is not an extension path.

Visual fidelity is contractual. The production-component gallery supplies deterministic web
and native captures; first baselines are approved side-by-side with the founder reference, then
path-filtered pixel gates protect them. Accessibility gates remain independent.

**Alternatives rejected.** Keep the three behaviours — preserves the aggregate rewrite and
optional-data mismatch. Store arbitrary fields — loses typing, stable PATCH paths and bounded
Sub-items. Infer an integration from labels — renaming user-visible words would silently change
domain behavior. Resolve presets at read time — lets a release mutate existing Lists without a
user action.

## ADR-059 — Native SQLite projections are frozen at migration 25 until device-verified

**Status:** Accepted · **Date:** 2026-09-01 · **Amends ADR-057**

**Context.** The P3-33…P3-40 review loop added native SQLite projections for the Plans tab,
Prep and source-List sections and the Updates feed (migrations 18–25) without a device to run
them on. The first device session found two defects in that code within minutes: an edited
already-applied migration, and an unserialized read transaction on the writer connection.
Meanwhile the web builds of the same screens had been exercised for days.

**Decision.** The native projection surface stays exactly as migration 25 leaves it. No new
native projection or reconciliation mechanism is added for Phase 3 screens until
the Plans tab, plan detail and Updates have been used on a phone through the normal flows and
the log-trace review at the Phase 3 checkpoint has run. Defects are fixed in place wherever
they are found. A corrective migration is allowed when it restores an existing mechanism's
compliance (an index, a constraint, a backfill) without expanding what native projects —
migration 26, the child-keyed Prep pointer index, is one; a committed migration is never
edited. The unused overlay tables from migrations 23–25 are left in the plan (contiguity
rule) and dropped in a later migration once no development database depends on them.

**Consequences.** Native screens may lag web by one reconciliation until the checkpoint;
that is accepted over untested storage code. The ADR-057 boundary (all native writes through
the durable intent log; HTTP only in the serialized sync owner) is unchanged.

**Amendment (2026-09-02 — native attachment projection).** The checkpoint’s phone-use
condition has now been met for Plans, Plan detail and Updates. Migration 27 is permitted to
add only the bounded Activity attachment projection: permanent media keys and attachment
metadata, its activity-and-ordinal index, and an installed/empty readiness bit. Canonical
detail pulls remain the only installer, and upload confirmation reuses the existing serialized
targeted-detail pull. This amendment does not reopen native projections generally and does not
permit media URLs, image bytes, thumbnails, cache state, another upload queue or another
reconciliation mechanism.

**Amendment (2026-09-03 — source-List delete visibility).** Migration 28 is a corrective
compliance migration for the existing bounded source-List projection. It adds one default-visible
bit to an existing source link so an optimistic List delete can retain exact rollback data while
hiding that link from a mounted Plan. The delete, retry and rejection transactions write the bit;
canonical detail replacement preserves a hidden bit until the List root is restored. Ordinary
projection readers remain independent of outbox tables and payload JSON. This does not add a new
projection, collection, queue or reconciliation owner.
