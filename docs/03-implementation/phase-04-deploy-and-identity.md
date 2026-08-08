# Phase 4 — Deploy and identity

## Goal

At the end of this phase the system runs on AWS and the user is a real person rather than a
constant. Four stacks — `AccountStack`, `DataStack`, `AuthStack`, `ApiStack` — are deployed
to the dev environment from a GitHub Actions workflow that assumes a short-lived OIDC role,
and the smoke tests that gate that workflow run against the deployed API rather than against
`localhost`. Cognito issues real tokens, the post-confirmation trigger creates the DynamoDB
profile that is the tenant key for every later request, and `CognitoIdentityProvider` slots
into the identity seam Phase 1 built so that not one route handler, service or repository
changes. A user can sign up with email and a password, verify it, sign in, sign in with
Apple, reset a forgotten password, and sign out — on iOS with the Keychain and on web with an
`HttpOnly` refresh cookie. A second user's identifiers return `404`, and there is a test that
says so.

This is also the phase where four phases of local-only development get audited against
reality. The divergence checklist (P4-15) is not paperwork; it is the reason this phase has a
task budget at all.

No domain, no CloudFront, no web hosting, no prod. The API is reached at its API Gateway
`execute-api` endpoint and Cognito at its default hosted-UI domain, both of which need no
DNS. Everything that needs a registered domain is Phase 5.

## Prerequisites

| # | Item | Notes |
| --- | --- | --- |
| 1 | Phases 0–3 complete and their acceptance criteria passing | The whole product runs on the laptop against DynamoDB Local with `AUTH_MODE=local`. |
| 2 | The identity seam exists and is unchanged | `services/api/src/middleware/identity.ts` exports the `IdentityProvider` interface and `LocalIdentityProvider`; every handler reads `c.get('userId')`; `packages/shared/src/api-client` takes an `AuthTokenProvider`. Phase 4 adds an implementation and flips a variable. It does not redesign the seam. |
| 3 | All eight CDK stacks synthesise and their assertion tests pass | Written in Phase 0, never deployed. `cdk synth` being green is not evidence that `cdk deploy` is. |
| 4 | An AWS account on the **Paid Plan**, a hardened root, an administrative identity, and the bootstrap budget | [`../02-architecture/infrastructure.md`](../02-architecture/infrastructure.md) §3.1–§3.4. If Phase 0 did not create the account, P4-03 creates it before anything else in this phase runs. |
| 5 | **Apple Developer Program enrolment started on day one of this phase** | $99/yr. Individual enrolment takes days; organisation enrolment with a D-U-N-S number takes weeks. Sign in with Apple cannot be built without it, and nothing about starting it early costs anything. See P4-01. |
| 6 | A permanent alert mailbox that can receive SNS confirmations | `alerts@` behind a forwarding rule. An unconfirmed SNS subscription means every alarm goes nowhere, silently. |

## Deliverables

- [ ] `cdk bootstrap` complete with the `odays` qualifier, and `AccountStack` deployed:
      budgets, cost anomaly detection, the GitHub OIDC provider, and both deploy roles.
- [ ] `DataStack`, `AuthStack` and `ApiStack` deployed to dev, reachable at the API Gateway
      `execute-api` endpoint.
- [ ] `deploy-dev.yml` green end to end on a merge to `main`, with no long-lived AWS
      credential anywhere.
- [ ] `scripts/smoke.mjs` running against the deployed dev API in CI, unauthenticated **and**
      authenticated.
- [ ] The local-versus-Lambda divergence checklist, executed, with each item either cleared
      or fixed, recorded in the pull request.
- [ ] Cognito user pool `od-users-dev`: attributes, password policy, optional TOTP MFA,
      email-only recovery, and the token lifetimes in
      [`../02-architecture/auth.md`](../02-architecture/auth.md) §1.6.
- [ ] The two public app clients with PKCE and refresh-token rotation, plus a CI-only client
      for the authenticated smoke test.
- [ ] Pre-sign-up and post-confirmation triggers, the latter creating `USER#/PROFILE`,
      `EMAIL#/USER` and writing `custom:app_user_id` back to Cognito.
- [ ] Sign in with Apple: App ID, Services ID, key in SSM, the Cognito identity provider, and
      the native sheet on iOS.
- [ ] `CognitoIdentityProvider` behind the Phase 1 `IdentityProvider` interface, and
      `AUTH_MODE=cognito` in the deployed environment.
- [ ] `POST /public/v1/auth/token`, `/refresh` and `/logout` with double-submit CSRF.
- [ ] Client auth: sign-up, confirm, sign-in, forgot-password, sign-out; `expo-secure-store`
      on iOS, the refresh cookie on web; a real `AuthTokenProvider`; single-flight refresh
      with one retry on `401`; the signed-out routing state.
- [ ] Authorisation middleware enforcing tenant isolation, with a cross-tenant test suite.
- [ ] The `min-token-issued-at` kill switch, rehearsed once.
- [ ] `ObservabilityStack` deployed to dev with a confirmed SNS subscription.
- [ ] A wiped and re-seeded local table, and a seed script that works against the deployed
      dev table for a real signed-in user.

## Tasks

| ID | Title | Area | Depends on | Parallel-safe | Size |
| --- | --- | --- | --- | --- | --- |
| P4-01 | Start Apple Developer Program enrolment | ops | — | yes | S |
| P4-02 | Apple App ID, Services ID, key, and the SSM parameters | ops/infra | P4-01 | no | M |
| P4-03 | AWS account preflight: paid plan, admin identity, bootstrap budget | infra | — | no | S |
| P4-04 | `cdk bootstrap` with the `odays` qualifier | infra | P4-03 | no | S |
| P4-05 | Make `ApiStack` deployable with no custom domain | infra | — | no | M |
| P4-06 | Deploy `AccountStack`: budgets, OIDC provider, deploy roles | infra | P4-04 | no | M |
| P4-07 | Deploy `DataStack` to dev and prove schema parity with the local table | infra | P4-04 | no | M |
| P4-08 | `AuthStack`: the user pool | infra | P4-04 | no | L |
| P4-09 | App clients, the default hosted-UI domain, and the CI client | infra | P4-08 | no | M |
| P4-10 | The Apple identity provider in `AuthStack` | infra | P4-02, P4-09 | no | M |
| P4-11 | Pre-sign-up trigger | api | P4-08 | no | M |
| P4-12 | Post-confirmation trigger | api | P4-08, P4-07 | no | L |
| P4-13 | Deploy `ApiStack` to dev with the `live` alias | infra | P4-05, P4-07, P4-09 | no | M |
| P4-14 | `deploy-dev.yml` green with OIDC | ci | P4-06, P4-13 | no | M |
| P4-15 | The local-versus-Lambda divergence checklist | api/infra | P4-13 | no | L |
| P4-16 | Smoke tests against the deployed dev environment | ci | P4-14, P4-17 | no | M |
| P4-17 | `CognitoIdentityProvider` and the `AUTH_MODE` flip | api | P4-09 | no | M |
| P4-18 | `/public/v1/auth/*`: token, refresh, logout, CSRF | api | P4-17 | no | L |
| P4-19 | Authorisation middleware and the cross-tenant `404` suite | api | P4-17 | no | M |
| P4-20 | The `min-token-issued-at` kill switch | api | P4-17 | yes | S |
| P4-21 | Token storage: `storage.ios.ts` and `storage.web.ts` | mobile | — | yes | M |
| P4-22 | The real `AuthTokenProvider` replacing `NullTokenProvider` | shared | P4-21 | no | M |
| P4-23 | Refresh with single-flight and one retry on `401` | shared | P4-22, P4-18 | no | M |
| P4-24 | Sign-up, confirm and sign-in screens | mobile | P4-22 | no | L |
| P4-25 | Forgot password and reset | mobile | P4-24 | no | M |
| P4-26 | Sign in with Apple on the client | mobile | P4-24, P4-10 | no | L |
| P4-27 | Sign-out and the signed-out routing state | mobile | P4-24 | no | M |
| P4-28 | Onboarding after first sign-in: display name and timezone | mobile | P4-24, P4-12 | no | M |
| P4-29 | Wipe the local table; keep `AUTH_MODE=local` working | api | P4-17 | no | S |
| P4-30 | Seed the deployed dev table for a real signed-in user | api | P4-12, P4-29 | no | M |
| P4-31 | Deploy `ObservabilityStack` to dev and confirm the subscription | infra | P4-13 | no | M |
| P4-32 | Cost allocation tags and the first-deploy cost check | ops | P4-06, P4-13 | yes | S |
| P4-33 | E2E: the auth journeys on web and iOS against dev | ci | P4-26, P4-27 | no | M |

P4-10 and P4-32 are mechanical and have no detail subsection. P4-10 is
[`../02-architecture/auth.md`](../02-architecture/auth.md) §2.2 step 5 verbatim:
`UserPoolIdentityProviderApple` reading the three SSM parameters from P4-02, attribute
mapping `email → email` and `name → name`, scopes `email name`. P4-32 is
[`../02-architecture/infrastructure.md`](../02-architecture/infrastructure.md) §2.4 —
activate `Project`, `Stage` and `Component` as cost allocation tags in the Billing console
on the day of the first deploy, because they are not retroactive and only appear in cost
reports from the day they are switched on.

> **Decision:** cross-phase dependencies in this table point at Phase 4 task IDs and, where
> they must reach further back, at Phases 2 and 3, whose numbering is stable. Phases 0 and 1
> were rewritten for local-first development and their IDs are not stable, so dependencies on
> them are stated in Prerequisites instead of in this column.

---

### P4-01 / P4-02 — Apple Developer Program and the Sign in with Apple credentials

**Start P4-01 on the first day of the phase.** It is the only item here with a calendar
dependency on somebody else, it blocks P4-10, P4-26 and P4-33, and the phase cannot close
without it. Individual enrolment is typically two to seven days. Organisation enrolment
requires a D-U-N-S number and has taken multiple weeks. Nothing else in the phase is blocked
by starting it, so there is no reason to wait.

**P4-02 files.** `infra/lib/stacks/auth-stack.ts` (the identity provider is P4-10); no
repository files hold any credential.

**Approach.** Exactly [`../02-architecture/auth.md`](../02-architecture/auth.md) §2.2:

1. Register the App ID `app.ordinarydays.ios` with the **Sign In with Apple** capability.
   Also register `app.ordinarydays.ios.dev`, which is what the dev builds use.
2. Register the Services ID `app.ordinarydays.signin`, with the primary App ID
   `app.ordinarydays.ios`.
3. Domains and return URLs on the Services ID use the **Cognito default hosted-UI domain**,
   which is what exists in this phase:
   - Domain: `od-dev.auth.us-east-1.amazoncognito.com`
   - Return URL: `https://od-dev.auth.us-east-1.amazoncognito.com/oauth2/idpresponse`
   Phase 5 adds `ordinarydays.app` and the prod pool's domain to the same Services ID. Both
   environments must be listed there simultaneously, or whichever is missing fails with a
   redirect mismatch that Apple reports unhelpfully.
4. Create the key, enable Sign In with Apple on it, associate the primary App ID, download
   the `.p8`. **It is downloadable exactly once.** Record the Key ID and the Team ID.
5. Store all three in SSM as `SecureString` and delete the local file:

```bash
aws ssm put-parameter --type SecureString --name /od/dev/auth/apple/team-id   --value 'ABCDE12345'
aws ssm put-parameter --type SecureString --name /od/dev/auth/apple/key-id    --value 'FGHIJ67890'
aws ssm put-parameter --type SecureString --name /od/dev/auth/apple/private-key \
  --value "$(cat AuthKey_FGHIJ67890.p8)"
rm AuthKey_FGHIJ67890.p8
```

**Edge cases.** Registering the sending domain with Apple's private email relay service is
**not** possible in this phase, because there is no verified sending domain until Phase 5.
That is acceptable: nothing in Phase 4 sends email to a user's address except Cognito's
verification and reset messages, and a Hide My Email user receives those at the relay address
through Cognito's own sender. Registering the relay domain is a Phase 5 task and a Phase 6
blocker for guest invitations.

**Tests.** Manual: the Services ID configuration screen lists the Cognito domain and the
`idpresponse` return URL exactly. A CDK assertion that `AuthStack` reads the three parameter
names above and that no value appears in the synthesised template.

---

### P4-03 / P4-04 — Account preflight and bootstrap

**Approach.** Walk [`../02-architecture/infrastructure.md`](../02-architecture/infrastructure.md)
§3.1–§3.6 in order. If the account already exists from Phase 0, this is a verification pass
and takes minutes; if it does not, it is the runbook.

The two items that are not recoverable if skipped:

1. **Billing → Free tier must show a plan of `Paid`.** The default Free Plan closes the
   account after six months with the data in it.
2. **The zero-spend budget and the anomaly monitor exist before the first `cdk deploy`.**
   `AccountStack` creates the permanent budgets, but it is itself a deploy, so the manual
   bootstrap budget is the safety net that covers it.

Bootstrap with the project qualifier so this project cannot collide with another CDK app in
the same account:

```bash
cd infra
export CDK_DEFAULT_ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
export CDK_DEFAULT_REGION=us-east-1
pnpm exec cdk bootstrap "aws://${CDK_DEFAULT_ACCOUNT}/us-east-1" \
  --qualifier odays \
  --cloudformation-execution-policies arn:aws:iam::aws:policy/AdministratorAccess
```

`@aws-cdk/core:bootstrapQualifier: "odays"` must already be in `cdk.json` context. A
qualifier mismatch between `cdk.json` and the bootstrap stack produces a deploy failure that
names a role ARN that does not exist, which reads like a permissions problem and is not.

**Tests.** `aws cloudformation describe-stacks --stack-name CDKToolkit` returns
`CREATE_COMPLETE`, and `aws iam get-role --role-name cdk-odays-deploy-role-<account>-us-east-1`
resolves.

---

### P4-05 — Make `ApiStack` deployable with no custom domain

**Files.** `infra/lib/config.ts`, `infra/lib/stacks/api-stack.ts`,
`infra/bin/ordinarydays.ts`, `apps/mobile/app.config.ts`.

**Why this is a task.** `ApiStack` as designed in
[`../02-architecture/infrastructure.md`](../02-architecture/infrastructure.md) §1.1 owns "the
custom domain + API mapping + A record", and takes `DnsStack` as a typed prop. There is no
hosted zone in this phase, so that dependency has to become optional rather than be worked
around at deploy time.

**Approach.** Make the DNS-dependent surface conditional on config, not on a comment:

- Add `apiDomain: z.string().optional()` and `webOrigins` to `EnvConfig`, and leave
  `apiDomain` unset for dev in this phase. Phase 5 sets it and the same code path builds the
  custom domain, the API mapping and the A record.
- `ApiStack`'s `dns` prop becomes optional. When it is absent the stack creates the HTTP API
  with the `$default` stage only, and exports `api.apiEndpoint`.
- `bin/ordinarydays.ts` instantiates only `AccountStack`, `DataStack`, `AuthStack`,
  `ApiStack` and `ObservabilityStack` for dev in this phase. `DnsStack`, `WebStack` and
  `SchedulerStack` still synthesise — their assertion tests keep running — but are not in the
  dev deploy set.
- `app.config.ts` gains an `EXPO_PUBLIC_API_BASE_URL` override so the client can point at the
  `execute-api` endpoint without hard-coding a generated hostname into a committed file. The
  `API` map keeps `local`, `dev` and `prod`; `dev` reads the override when it is set.

> **Decision: the dev API is reached at
> `https://<api-id>.execute-api.us-east-1.amazonaws.com` for the whole of Phase 4.** The
> alternative — registering the domain now — pulls Route 53, ACM, DNS validation and the
> CloudFront distribution forward into a phase whose purpose is to prove that the application
> runs on Lambda. The endpoint is ugly and it is enough. The cost of deferring is one cutover
> task in Phase 5 and the `SameSite=None` cookie compromise in P4-18, both of which are
> written down rather than discovered.

**Edge cases.** The `$default` stage on an HTTP API adds **no** path prefix, so routes are
`/v1/...` exactly as locally. A named stage would prefix every path and break every client
route at once. Assert `stageName: '$default'` in the CDK test.

**Tests.** A CDK assertion that when `cfg.apiDomain` is undefined the template contains no
`AWS::ApiGatewayV2::DomainName` and no `AWS::Route53::RecordSet`, and that when it is set it
contains exactly one of each.

---

### P4-06 — `AccountStack` and the GitHub OIDC roles

**Files.** `infra/lib/stacks/account-stack.ts`.

**Approach.** As written in
[`../02-architecture/infrastructure.md`](../02-architecture/infrastructure.md) §3.8. Two
things are load-bearing and are the reason this is not mechanical:

- The `sub` claim **must** be constrained. A trust policy carrying only the `aud` condition
  lets any GitHub repository in the world assume the role. `od-github-deploy-dev` uses
  `StringLike` on `repo:ujjwal/ordinarydays:ref:refs/heads/main`;
  `od-github-deploy-prod` uses `StringEquals` on
  `repo:ujjwal/ordinarydays:environment:production` — environment subjects are not patterns.
- Each role may assume only the three CDK bootstrap roles and may describe only its own
  stage's stacks. A dev pipeline that can reach `od-*-prod` is not a dev pipeline.

Set the GitHub repository variable `AWS_ACCOUNT_ID` and create the `development` and
`production` GitHub environments in the same task, with a required reviewer and a five-minute
wait timer on `production`. The prod role is created here and used in Phase 5; creating it
now costs nothing and avoids a second `AccountStack` deploy later.

**Edge cases.** An IAM OIDC provider for `token.actions.githubusercontent.com` can exist only
once per account. If one already exists, import it rather than creating a second, or the
deploy fails with `EntityAlreadyExists` on a resource CloudFormation will then refuse to roll
back cleanly.

**Tests.** A CDK assertion that both role trust policies contain a `sub` condition. A live
check: run the `synth` job from a branch and confirm it obtains credentials and that
`aws sts get-caller-identity` reports `od-github-deploy-dev`.

---

### P4-07 — `DataStack` and schema parity

**Files.** `infra/lib/stacks/data-stack.ts`, `services/api/scripts/create-local-table.ts`.

**Approach.** Deploy the table `od-main-dev` and `GSI1`, the media bucket with its lifecycle
rules and CORS. Dev carries `RemovalPolicy.DESTROY`, no PITR and no deletion protection —
prod protections are Phase 5.

The parity check is the point of the task. `create-local-table.ts` and `DataStack` already
read their key schema from one shared module, and a test asserts the synthesised table
definition matches the local one
([`../02-architecture/infrastructure.md`](../02-architecture/infrastructure.md) §6.1). Now
verify it against the deployed resource rather than against the template:

```bash
aws dynamodb describe-table --table-name od-main-dev \
  --query '{keys:Table.KeySchema, attrs:Table.AttributeDefinitions, gsi:Table.GlobalSecondaryIndexes[].{n:IndexName,k:KeySchema,p:Projection}}'
```

and diff it against the same projection taken from DynamoDB Local. The `GSI1` projection is
`INCLUDE` with the `AgendaItem` field list; changing a GSI projection later requires
replacing the index, so a mismatch found now is cheap and a mismatch found in Phase 6 is not.

**Edge cases.** DynamoDB Local ignores billing mode. The deployed table is on-demand; confirm
`BillingModeSummary.BillingMode` is `PAY_PER_REQUEST` and not a provisioned default, because
provisioned capacity is a standing charge.

**Tests.** A script `infra/scripts/check-table-parity.ts` run in the deploy job comparing the
two descriptions and failing on any difference in key schema, attribute definitions or index
projection.

---

### P4-08 / P4-09 — The user pool, the app clients, and the CI client

**Files.** `infra/lib/stacks/auth-stack.ts`.

**Approach.** Implement
[`../02-architecture/auth.md`](../02-architecture/auth.md) §1.1–§1.7 exactly: email-only
sign-in alias, `signInCaseSensitive: false`, `autoVerify.email`, `keepOriginal.email`, the two
custom attributes with `app_user_id` **immutable**, the 12-character password policy with no
symbol requirement, `Mfa.OPTIONAL` with TOTP only and SMS disabled, `AccountRecovery.EMAIL_ONLY`
with an explicit 15-minute code validity, ID and access tokens at 60 minutes, refresh at 90
days on mobile and 30 days on web, and refresh token rotation with a 60-second grace period on
both public clients.

Both public clients have **no client secret** and allow only `ALLOW_USER_SRP_AUTH` and
`ALLOW_REFRESH_TOKEN_AUTH`. `ALLOW_USER_PASSWORD_AUTH` stays disabled: it transmits the
plaintext password to Cognito's API, and SRP never transmits it at all.

Callback and logout URLs in this phase, with no domain:

| Client | Callback URLs | Logout URLs |
| --- | --- | --- |
| `od-mobile-dev` | `ordinarydays-dev://auth/callback`, `exp://127.0.0.1:8081/--/auth/callback` | `ordinarydays-dev://auth/signout` |
| `od-web-dev` | `http://localhost:8081/auth/callback` | `http://localhost:8081/` |

The user pool domain is the **Cognito default**: prefix `od-dev`, giving
`od-dev.auth.us-east-1.amazoncognito.com`. It needs no certificate and no DNS record. A
custom auth domain requires an A record at the zone apex and is deliberately not used at all
— it is not on the Phase 5 list either.

> **Decision: a third, non-public app client `od-ci-dev` is created for the authenticated
> smoke test.** `scripts/smoke.mjs` mints a token for a dedicated test user with
> `AdminInitiateAuth`, which requires `ALLOW_ADMIN_USER_PASSWORD_AUTH` — a flow that must not
> exist on either client a real user's app talks to. So it gets its own client, with no OAuth
> flows, no callback URLs, and `ADMIN_USER_PASSWORD_AUTH` plus `REFRESH_TOKEN_AUTH` only. The
> consequence is that the JWT verifier's `clientId` list has **three** entries in dev, which
> is an amendment to [`../02-architecture/auth.md`](../02-architecture/auth.md) §1.7 and §5.1
> and lands in the same pull request.

**Edge cases.**

- Cognito's default email sender is capped at **50 messages per day** and sends from an
  `amazonaws.com` address that frequently lands in spam. That is tolerable for one founder
  testing sign-up in dev, and it is why `auth.md` §1.8 specifies SES. SES needs a verified
  domain, so the switch to SES is a Phase 5 task. Note it in the phase-5 out-of-scope table
  in the same PR, and expect verification emails in the spam folder until then.
- Refresh token rotation may need a `CfnUserPoolClient` escape hatch depending on the CDK
  version in the lockfile. Verify the property names against the installed version rather
  than copying them.
- The pool's `removalPolicy` in dev is `DESTROY`. That is correct and it means a
  `cdk destroy` deletes every dev account. Nothing of value is in one; that is the premise of
  P4-29.

**Tests.** CDK assertions on: `signInCaseSensitive: false`, the password policy fields, MFA
`OPTIONAL` with SMS off, `app_user_id` mutability `false`, `preventUserExistenceErrors: true`,
and that neither public client declares `ALLOW_USER_PASSWORD_AUTH` or
`ALLOW_ADMIN_USER_PASSWORD_AUTH`. A live check that `AdminInitiateAuth` against
`od-mobile-dev` is rejected and against `od-ci-dev` succeeds.

---

### P4-11 / P4-12 — The Cognito triggers

**Files.** `services/api/src/triggers/pre-signup.ts`,
`services/api/src/triggers/post-confirmation.ts`.

**Approach.** [`../02-architecture/auth.md`](../02-architecture/auth.md) §1.9, implemented
verbatim. Pre-sign-up lowercases and trims the email, rejects a small disposable-domain
blocklist, links an existing Cognito-native identity on a federated sign-up with the same
**verified** address, and never auto-confirms.

Post-confirmation is the only place a user profile is created. It generates
`userId = 'usr_' + ulid()`, writes `USER#<userId>/PROFILE` and `EMAIL#<lowercased-email>/USER`
in one `TransactWriteItems` with `attribute_not_exists(pk)` on both, then calls
`AdminUpdateUserAttributes` to write `custom:app_user_id`. Any failure throws, so Cognito
reports the sign-up as failed — a confirmed Cognito user with no DynamoDB profile is a broken
account that `500`s on every subsequent request.

The guest-linking step in §1.9 item 4 is **Phase 6**. Write the call site as a named no-op
function with a comment naming the phase, so the ordering (link only after
`email_verified === true`) is established now and Phase 6 fills in the body rather than
re-deciding where it goes.

**Edge cases.**

- **Idempotency by construction.** Cognito retries triggers. The two conditional puts are
  what make a retry safe; without them a retry creates a second profile with a second
  `userId` and the account is permanently ambiguous.
- The trigger has a **5-second** Cognito timeout, which is shorter than the API Lambda's 15.
  Set it explicitly and keep the handler's cold start small — the trigger bundles the
  repository layer, not the whole Hono app.
- Each trigger gets its **own execution role**. The post-confirmation role needs
  `dynamodb:PutItem` and `dynamodb:TransactWriteItems` on the table and
  `cognito-idp:AdminUpdateUserAttributes` on the pool, and nothing else. Granting it the API's
  role because it is convenient gives a sign-up path the ability to read every user's data.
- `AdminUpdateUserAttributes` on the pool creates a circular reference in CDK if the pool
  grants the trigger and the trigger is a pool property. Resolve it with an explicit
  `iam.PolicyStatement` on the pool ARN added after both constructs exist, not with a
  wildcard resource.

**Tests.** Unit with `aws-sdk-client-mock`: a duplicate invocation writes no second profile;
a `TransactionCanceledException` with `ConditionalCheckFailed` on the `EMAIL#` put is treated
as an existing account rather than swallowed. Live: sign up in dev, confirm, and assert the
ID token on the next sign-in carries `custom:app_user_id` matching the `USER#` partition
written in DynamoDB.

---

### P4-13 — Deploy `ApiStack` with the `live` alias

**Files.** `infra/lib/stacks/api-stack.ts`.

**Approach.** The API Lambda at 1024 MB and a 15-second timeout, reserved concurrency 20 in
dev, ARM64, Node 22, ESM bundle with the `createRequire` banner, JSON log format, explicit log
retention. API Gateway HTTP API with the `$default` route and the `$default` stage, an access
log group, and throttle settings.

Publish a version on every deploy and point the integration at an **alias**, from the first
deploy:

```ts
const alias = new lambda.Alias(this, 'LiveAlias', {
  aliasName: 'live',
  version: apiFn.currentVersion,
});
new apigwv2Integrations.HttpLambdaIntegration('ApiIntegration', alias);
```

Doing this later means the rollback path in
[`../02-architecture/infrastructure.md`](../02-architecture/infrastructure.md) §4.4 does not
exist when it is first needed. It costs nothing now.

Environment variables are identifiers only: `STAGE`, `TABLE_NAME`, `MEDIA_BUCKET`,
`COGNITO_USER_POOL_ID`, `COGNITO_MOBILE_CLIENT_ID`, `COGNITO_WEB_CLIENT_ID`,
`COGNITO_CI_CLIENT_ID`, `AUTH_MODE=cognito`, `LOG_LEVEL`. **`DDB_ENDPOINT` must not be
present** — see P4-15.

**Tests.** A CDK assertion that the integration target is an alias ARN and not `$LATEST`, that
`AUTH_MODE` is `cognito`, and that `DDB_ENDPOINT` does not appear in the environment map.
`curl "$API_URL/v1/health"` returns `200` with the deployed git SHA.

---

### P4-14 — `deploy-dev.yml` green with OIDC

**Files.** `.github/workflows/deploy-dev.yml`, `.github/workflows/ci.yml`.

**Approach.** The workflow already exists from Phase 0 and has never obtained a credential.
Make it run: `aws-actions/configure-aws-credentials@v4` assuming
`od-github-deploy-dev`, then `cdk deploy` of the dev stack set, then the smoke tests. Drop the
`expo export --platform web` and the Playwright-against-`dev.ordinarydays.app` steps for now —
there is no web hosting until Phase 5 — and leave a comment naming the phase that restores
them.

`permissions: { id-token: write, contents: read }` at the job level is required for OIDC and
is the single most common reason the credential step fails with
`Not authorized to perform sts:AssumeRoleWithWebIdentity`.

`concurrency: { group: deploy-dev, cancel-in-progress: false }` is deliberate: cancelling a
CloudFormation deploy mid-flight leaves a stack in `UPDATE_IN_PROGRESS` that needs manual
recovery. Deploys queue.

Enable the `ci.yml` `synth` job's `cdk diff` PR comment in the same task — it is the first
time a diff has ever been read against a real account, and from here on it is the main defence
against an accidental replacement of a stateful resource.

**Edge cases.** A pull request from a fork gets no `id-token` and therefore no credential.
Skip the diff step there rather than failing the job; an untrusted PR must not be able to read
the account.

**Tests.** Merge a no-op commit to `main` and watch the workflow deploy, smoke-test and go
green. Then merge a commit that changes the health endpoint's response and confirm the smoke
test's SHA assertion catches a stale deploy.

---

### P4-15 — The local-versus-Lambda divergence checklist

**This is the highest-risk task in the phase.** Four phases of application code have been
written and tested against a long-lived Node process, a permissive local DynamoDB, and a
laptop's environment. Every assumption that made that convenient is a candidate defect now.

Work the list below in order. Each row is done when the detection step has been **run** and
its result recorded in the pull request — not when it has been read. The output of this task
is a checked list with evidence, plus whatever fixes it produced.

**1. API Gateway v2 event shape versus the Hono Node adapter**

Locally the app is served by `@hono/node-server` and receives real `Request` objects. Deployed,
`hono/aws-lambda`'s `handle` translates an API Gateway **payload format 2.0** event. The
differences that bite:

- Cookies arrive in `event.cookies` as an **array**, not in a `Cookie` header, and response
  `Set-Cookie` values must be returned in the response's `cookies` array or multiple cookies
  collapse into one. This lands directly on P4-18's refresh cookie and the CSRF cookie.
- The path is `event.rawPath` and the method is `event.requestContext.http.method`, not
  `httpMethod` — that is payload format 1.0 and is what most examples show.
- Repeated query parameters are **comma-joined** into one value in `queryStringParameters`.
  `?include=a&include=b` arrives as `a,b`. Our `include` parameter is already comma-separated,
  so this is benign, but any future repeated parameter is not.
- Binary bodies arrive base64-encoded with `isBase64Encoded: true`.
- API Gateway caps the request at 10 MB and the Lambda response at 6 MB. The local server caps
  neither.

**Detect:** capture one real event with
`aws logs tail /aws/lambda/od-api-dev --format short` after a request, save it as
`services/api/test/fixtures/apigw-v2-event.json`, and add an integration test that drives the
**exported `handler`** with that fixture rather than `app.fetch`. Every existing route test
uses `app.fetch`; at least one per middleware must now go through the adapter.
**Do:** fix the cookie read/write to use the adapter's cookie helpers, and keep the fixture
under test so a future Hono upgrade that changes the adapter fails in CI.

**2. IAM denials DynamoDB Local never produced**

DynamoDB Local ignores IAM entirely, so every repository method has been running with implicit
root access. The denials that surface on first deploy, in the order they usually appear:

| Missing permission | Symptom |
| --- | --- |
| `dynamodb:Query` on the **index** ARN | Every agenda and list query `AccessDeniedException`s while item reads work |
| `dynamodb:ConditionCheckItem` | `TransactWriteItems` containing a `ConditionCheck` fails, plain writes succeed |
| `ssm:GetParameter` on `/od/dev/*` plus `kms:Decrypt` | The first secret read at cold start throws and every request after it `500`s |
| `s3:PutObject` scoped to `u/*` | Attachment presign succeeds and the upload fails, which looks like a client bug |
| `cognito-idp:AdminUpdateUserAttributes` | Sign-up completes in Cognito and then fails, leaving no profile |

The explicit `Deny` on `dynamodb:Scan` in
[`../02-architecture/security-privacy.md`](../02-architecture/security-privacy.md) §2.2 is now
live. Any accidental scan that worked locally fails hard here, which is the intended outcome.

**Detect:** run the full repository integration suite against the **deployed dev table** once,
as a one-off `pnpm test:integration --stage=dev` run from a laptop with the Lambda's role
assumed, then query CloudWatch Logs Insights for `AccessDenied` across the deploy window.
**Do:** add the exact grant for each denial. Never widen to `Resource: "*"`; a denial is
information about what the code actually needs.

**3. `TransactWriteItems` limits and conditional-check failures**

DynamoDB Local is looser than the service in ways that all fail in the same direction:

- Real DynamoDB rejects a transaction containing **two operations on the same item** with a
  `ValidationException`. The activity-plus-index writes and the delete cascade are the places
  this can happen after a refactor.
- The real limit is 100 items and 4 MB per transaction. Check the item counts recorded in
  [`../02-architecture/data-model.md`](../02-architecture/data-model.md) §7 against the
  cascade delete for an activity with many participants, updates and occurrences, and batch
  where it can exceed the limit.
- Failures arrive as one `TransactionCanceledException` whose `CancellationReasons` array must
  be read positionally. `ConditionalCheckFailed` is a `409 conflict`; `TransactionConflict` is
  a concurrent write and should be **retried** with jitter, at most three times;
  `ThrottlingError` can occur on an on-demand table during a partition split and never occurs
  locally. Collapsing all three into `409` makes a transient conflict look like a user error.
- `ReturnValuesOnConditionCheckFailure: 'ALL_OLD'` must be requested explicitly to get the
  conflicting item back for an `If-Match` response.

**Detect:** an integration test that runs the transaction paths against the deployed dev table
and asserts the mapping from each `CancellationReasons[i].Code` to an `AppError` code. Force a
`TransactionConflict` with two concurrent writers.
**Do:** implement the reason mapping and the bounded retry in the repository base, once, not
per call site.

**4. Cold starts and module-scope singletons**

Locally, module scope is a permanent cache in a process that never dies. On Lambda each
execution environment has its own, and it is **frozen** between invocations.

- A promise started at module scope and never awaited does not progress after the response is
  returned. It resumes on the next invocation, so an unawaited initialiser appears to work and
  then yields an uninitialised value or a delayed rejection. The JWKS hydrate in
  [`../02-architecture/auth.md`](../02-architecture/auth.md) §5.1 is written correctly —
  created at module scope, `await`ed in the middleware. Every other module-scope promise must
  follow the same shape.
- An unhandled rejection on a frozen promise crashes a **later** invocation, on an unrelated
  request, with a stack that points nowhere useful. Attach a `.catch` to every module-scope
  promise at the point it is created.
- In-process caches are per-execution-environment, not global. The rate limiter is
  DynamoDB-backed, which is correct; assert that no counter or lock lives in a module-level
  `Map`. The secret cache is per-environment by design, with a 5-minute TTL.
- The init budget is **400 ms p95** ([`definition-of-done.md`](definition-of-done.md) §6).

**Detect:** the cold-start job — force execution-environment recycling by updating an
environment variable on the function, invoke three times, and read `initDuration` from the
`REPORT` line. Add it to `deploy-dev.yml`. Add a lint rule failing on a top-level `await`
outside an exported init function.
**Do:** move any work that can be deferred out of init; keep the AWS SDK clients at module
scope, since constructing them per request is worse.

**5. Bundle size and esbuild externals**

`tsx` resolves from `node_modules` at runtime; the deployed artifact contains only what
esbuild traced.

- Anything loaded by a computed path or a runtime `require` is not in the bundle and throws
  `Cannot find module` on the first invocation that reaches it. `pino` transports are the
  classic case: they spawn a worker thread and resolve the transport by name. The Lambda
  logger must write JSON to stdout with **no transport**.
- The ESM `banner` injecting `createRequire` is required by transitive CommonJS dependencies
  and is already in the `NodeLambda` construct. Assert it is in the synthesised code property.
- The 5 MB zipped gate is already enforced by `scripts/check-bundle-size.mjs`.

> **Decision: `@aws-sdk/*` is bundled, not externalised.** The managed runtime ships a copy,
> but its version is not pinned to the lockfile and can change under the function without a
> deploy. Bundling makes the deployed SDK version the one CI tested, at a cost of roughly one
> megabyte against a five-megabyte budget. Revisit only if the budget becomes binding.

**Detect:** in CI, after the bundle is built, run
`node --input-type=module -e "import('./dist/index.mjs')"` — a smoke import that catches a
missing module without a deploy. Then the deployed smoke test catches the rest.
**Do:** `sourceMap: true` on dev with `NODE_OPTIONS=--enable-source-maps`, or every stack
trace is minified single-letter identifiers.

**6. Environment variables and secret resolution**

Locally `services/api/.env.local` is loaded by `tsx`. On Lambda nothing loads it and nothing
ever will.

- Any `process.env.X ?? 'default'` silently works locally and is silently wrong deployed.
  All environment reading goes through **one** `config.ts` that parses `process.env` with Zod
  at module scope and **throws on a missing key**, so a misconfiguration fails at init,
  visibly, on the first deploy.
- `DDB_ENDPOINT` must be absent in the deployed environment map. If it leaks in, the client
  points at `localhost:8000`, every call hangs, and the function times out at 15 seconds with
  no error that names the cause.
- `AWS_ACCESS_KEY_ID=local` and friends exist only locally; deployed credentials come from the
  role.
- Secrets come from SSM through the cached `getSecret` path, never from an environment
  variable. A `console` reader of the function configuration must learn nothing.

**Detect:** a CDK assertion that the set of keys in `ApiStack`'s environment map exactly equals
the set of keys the Zod config marks required, and that `DDB_ENDPOINT` is not among them.
**Do:** fix the config module first; the assertion then keeps it true.

**7. Clock and timezone**

Lambda runs with `TZ=UTC`. The laptop does not.

- `Date#getHours`, `toLocaleDateString` and any `Intl` formatter without an explicit
  `timeZone` return different answers in the two environments. The recurrence engine is pure
  and takes `timezone` as a parameter, so it is safe by construction — the exposure is in
  handlers, the agenda projection and anything that formats a date for a response.
- The Node 22 managed runtime has full ICU; a bundler configuration that dropped locale data
  would change formatting. Assert one `Intl`-dependent format in a deployed smoke check rather
  than assuming.

**Detect:** run the API unit suite twice in CI, once with `TZ=UTC` and once with
`TZ=Pacific/Auckland`, and fail on any difference. Add a lint rule banning `getHours`,
`getDate` and `toLocaleDateString` outside `packages/shared/src/recurrence/calendar.ts`.
**Do:** pass an explicit `timeZone` to every formatter, or move the formatting into the shared
calendar module where it is already parameterised.

**8. Header case and header handling**

API Gateway lowercases every header name in `event.headers`; Node's `http` also lowercases, so
Hono's `c.req.header()` is case-insensitive in both. The divergence is in code that bypasses
it.

- Reading `event.headers['X-Client-Version']` directly returns `undefined` deployed and works
  locally on some paths. Nothing may read the raw event outside the adapter.
- Duplicate headers are comma-joined by API Gateway.
- `Set-Cookie` is the exception on the response side and must go through the `cookies` array
  (item 1).
- `Authorization` is forwarded by HTTP API by default. It is **not** forwarded by a CloudFront
  distribution unless the origin request policy says so — a Phase 5 problem, recorded here so
  it is not rediscovered.

**Detect:** a route test driving the exported `handler` with mixed-case header names in the
v2 fixture, asserting `X-Request-Id`, `Idempotency-Key`, `X-Client-Timezone` and
`Authorization` all resolve.
**Do:** a lint rule banning direct `event.headers` access in `services/api/src`.

**Deliverable for this task.** A checklist in the pull request with eight rows, each carrying
the detection command that was run, its output, and either "no divergence" or the commit that
fixed it. A row marked "no divergence" with no evidence is not done.

---

### P4-16 — Smoke tests against the deployed dev environment

**Files.** `scripts/smoke.mjs`, `.github/workflows/deploy-dev.yml`.

**Approach.** Two halves, both gating the deploy:

1. **Unauthenticated.** `GET /v1/health` returns `200` and a `sha` equal to `github.sha`.
   Asserting the SHA is what turns the smoke test from a liveness check into a deploy check —
   a `200` from the previous version is a passing smoke test on a failed deploy.
2. **Authenticated.** Mint an ID token for a dedicated test user with `AdminInitiateAuth`
   against `od-ci-dev` (P4-09), call `GET /v1/me` and one list endpoint, and assert `200` and
   that the returned `userId` is the test user's. Then call the same endpoint with the token's
   final character mutated and assert `401`.

The test user's password lives in GitHub Actions secrets. The deploy role's policy allows
`cognito-idp:AdminInitiateAuth` on the pool only, and only for that client.

**Edge cases.** A test user in `FORCE_CHANGE_PASSWORD` state fails `AdminInitiateAuth` with a
challenge rather than tokens. Create it with `AdminSetUserPassword --permanent` and confirm
its email attribute so the state is `CONFIRMED`. A test user whose profile row was deleted by
a wipe returns `401 account setup incomplete` from the identity middleware, which is correct
behaviour and a confusing smoke failure — the wipe procedure in P4-29 must re-create it.

**Tests.** The smoke script is the test. Verify it fails correctly by pointing it at the
previous version's alias and confirming the SHA assertion trips.

---

### P4-17 — `CognitoIdentityProvider` and the `AUTH_MODE` flip

**Files.** `services/api/src/middleware/identity.ts` (add an implementation),
`services/api/src/middleware/cognito-identity.ts`, `infra/lib/stacks/api-stack.ts`.

**This task must not touch a single route handler, service or repository.** That is the whole
point of the seam Phase 1 built. If the implementation appears to require a change under
`services/api/src/routes/`, `.../services/` or `.../repositories/`, stop and say so in the
pull request: either the seam is wrong or the change is unnecessary, and both are worth five
minutes of argument now rather than a re-plumbing later.

**Approach.** Implement the existing interface with `aws-jwt-verify`, as in
[`../02-architecture/auth.md`](../02-architecture/auth.md) §5.1:

- `CognitoJwtVerifier.create` at **module scope**, `tokenUse: 'id'`, with the three dev client
  IDs. Creating it inside the handler refetches the JWKS on every request and adds 50–200 ms
  to every single API call — the most common Cognito performance mistake there is.
- `verifier.hydrate()` at init with a `.catch`, awaited in the middleware.
- The tenant key is `claims['custom:app_user_id']` and nothing else. A token whose claim is
  missing or does not start with `usr_` means the post-confirmation trigger did not complete;
  return `401` with `Account setup incomplete.`, not a `500`.
- No verification-result cache. Verification against a cached JWKS is microseconds, and a
  result cache only creates a window in which a revoked session still works.

The selection stays where Phase 1 put it: `AUTH_MODE` resolved once at module scope, with the
startup throw when `AUTH_MODE === 'local'` and `STAGE !== 'local'`. Phase 4 adds the
`'cognito'` branch and sets `AUTH_MODE=cognito` in `ApiStack`'s environment.

> **Conflict to resolve in this pull request.**
> [`../02-architecture/infrastructure.md`](../02-architecture/infrastructure.md) §6.2 and
> [`../04-conventions/testing.md`](../04-conventions/testing.md) still describe `AUTH_MODE` as
> `cognito | dev-bypass` with an `X-Dev-User` header. The shipped seam is `local | cognito`
> with a constant user ID and no header. Amend both documents to the implemented values in the
> same PR; do not add a third mode.

**Edge cases.** The verifier's `clientId` array must include the CI client or every smoke-test
token fails `aud` validation with a message about the audience that reads like a
misconfiguration of the pool.

**Tests.** Unit: a token signed by a different pool is rejected; an access token is rejected on
`token_use`; an expired token is rejected; a valid token with no `custom:app_user_id` returns
`401` with the setup-incomplete code. A test asserting the startup throw when
`AUTH_MODE=local` and `STAGE=dev`. A CDK assertion that the deployed environment sets
`cognito`.

---

### P4-18 — `/public/v1/auth/*` and the web refresh cookie

**Files.** `services/api/src/routes/public/auth.ts`,
`packages/shared/src/schemas/auth.ts`.

**Approach.** The three endpoints in
[`../02-architecture/api-contract.md`](../02-architecture/api-contract.md) §2.0, with the
rationale in [`../02-architecture/auth.md`](../02-architecture/auth.md) §4.2:

| Method | Path | Behaviour |
| --- | --- | --- |
| `POST` | `/public/v1/auth/token` | `{ code, codeVerifier, redirectUri }` → Cognito `/oauth2/token`. Returns `{ idToken, accessToken, expiresIn }`; sets the refresh cookie. |
| `POST` | `/public/v1/auth/refresh` | Reads the cookie, calls `REFRESH_TOKEN_AUTH`, returns a new ID token, rotates the cookie. |
| `POST` | `/public/v1/auth/logout` | `GlobalSignOut`, clears the cookie with `Max-Age=0`. |

All three require a **double-submit CSRF token**: a non-`HttpOnly` cookie whose value must be
echoed in an `X-CSRF-Token` header, compared with a constant-time comparison. `SameSite`
alone does not protect a `POST` from a top-level cross-site navigation in every browser.

Rate limits: 10 req/min per IP on all three, and 60/hour per IP on `/refresh`
([`../02-architecture/api-contract.md`](../02-architecture/api-contract.md) §4). These are the
only `/public/v1` routes that set cookies, and they are the first `/public/v1` routes to exist
— confirm that `routeSplit` puts them outside the identity middleware and that nothing else
slipped in with them.

> **Decision: in dev the refresh cookie is `HttpOnly; Secure; SameSite=None`, host-scoped to
> the `execute-api` domain.** The web client runs at `http://localhost:8081` and the API at
> `https://<id>.execute-api.us-east-1.amazonaws.com`, which are cross-site, so `SameSite=Lax`
> would drop the cookie on every `fetch`. The attributes are read from `EnvConfig`, not
> hard-coded, and Phase 5 sets them to `SameSite=Lax` with `Domain=.ordinarydays.app` once
> both sit under one registrable domain. `Secure` and `HttpOnly` are never relaxed, in any
> environment, and the CSRF check is what carries the weight while `SameSite` is `None`.

**Edge cases.**

- Under API Gateway v2, request cookies arrive in `event.cookies` and response cookies must be
  returned in the response's `cookies` array. This is divergence item 1 in P4-15 and it lands
  here first. A second `Set-Cookie` written as a plain header silently replaces the first, so
  the CSRF cookie and the refresh cookie will collide if this is wrong.
- CORS: `credentials: true` with an explicit origin allow-list, never `*` — the browser
  rejects that combination anyway. `http://localhost:8081` goes in the dev allow-list.
- The Cognito token endpoint returns a rotated refresh token on every refresh. Persisting the
  new one is not optional; with rotation enabled, replaying the old one terminates the session.
- The exchange endpoint must not echo Cognito's error body. Map to `401 unauthenticated` with
  a generic message; Cognito's errors distinguish cases we deliberately do not.

**Tests.** Integration through the exported handler with the v2 fixture: a valid exchange sets
exactly two cookies with the right attributes; a refresh with no cookie returns `401`; a
refresh with the cookie and no `X-CSRF-Token` returns `403`; a mismatched CSRF value returns
`403`; logout clears the cookie with `Max-Age=0`. A test asserting the cookie attributes come
from config, by synthesising both configurations.

---

### P4-19 — Authorisation middleware and the cross-tenant suite

**Files.** `services/api/src/middleware/authorize.ts`,
`services/api/src/services/access.ts`.

**Approach.** [`../02-architecture/api-contract.md`](../02-architecture/api-contract.md) §3.
Ownership is established by loading `ACT#<id>/META` and comparing `ownerId` to the token's
tenant key. **Never trust an ID in a path, query or body.** A caller with no relationship to
the resource gets `404 not_found`, never `403` — `403` confirms the resource exists.

Until Phase 6 there are no participants, so the rule set is short: owner or nobody. Write it
as the general `assertActivityAccess(userId, activity, action)` function anyway, with the
participant branch present and returning `404`, so Phase 6 fills in a table rather than
restructures a middleware.

The user-partition reads need no ownership check because the key is derived from the token —
that is the property the whole key design buys, and it is worth stating in a comment at
`keys.ts` so nobody "adds a check for safety" that reintroduces a path-supplied user ID.

**Edge cases.** A soft-deleted profile must `401` from Phase 5 onward; the hook belongs in the
identity middleware, not here, and is out of scope now.

**Tests.** The cross-tenant suite is the deliverable. Create two users in dev, `A` and `B`,
seed `A` with an activity, a list and an attachment, then assert as `B`:

| Request | Expected |
| --- | --- |
| `GET /v1/activities/<A's id>` | `404` |
| `PATCH /v1/activities/<A's id>` | `404` |
| `DELETE /v1/activities/<A's id>` | `404` |
| `POST /v1/activities/<A's id>/duplicate` | `404` |
| `GET /v1/lists/<A's list id>` | `404` |
| `POST /v1/lists/<A's list id>/items` | `404` |
| `GET /v1/agenda` | `200` with none of `A`'s items |
| Any of the above with no token | `401` |

Every response body is asserted to contain no title, no owner identifier and no hint that the
resource exists. This suite runs against DynamoDB Local in CI and once against deployed dev in
this phase.

---

### P4-20 — The `min-token-issued-at` kill switch

**Approach.** Mechanical, but it has to exist before there are users rather than during an
incident. An SSM parameter `/od/dev/auth/min-token-issued-at` holding an epoch second, read
through the standard 5-minute cached `getSecret` path. The identity middleware compares it
against the token's `iat` and returns `401` for anything older. Absent parameter means no
floor — the safe default, per [`definition-of-done.md`](definition-of-done.md) §11.

This is the only mechanism that revokes **every** session at once without a deploy
([`../02-architecture/security-privacy.md`](../02-architecture/security-privacy.md) §9.1).
That document places it in "Phase 3"; auth does not exist until Phase 4, so it lands here and
§9.1 is amended in the same PR.

**Tests.** Set the parameter to `now` on dev, confirm an existing token stops working within
five minutes with no deploy, then clear it. Record the elapsed time. A flag past its removal
date is a nightly failure, so record this one as permanent configuration rather than a flag.

---

### P4-21 / P4-22 / P4-23 — Token storage, the token provider, and refresh

**Files.** `apps/mobile/src/lib/storage.ios.ts`, `apps/mobile/src/lib/storage.web.ts`,
`packages/shared/src/api-client/auth-token-provider.ts`.

**Approach.** iOS uses `expo-secure-store` with
`keychainAccessible: WHEN_UNLOCKED_THIS_DEVICE_ONLY`, which keeps the item out of iCloud
Keychain and out of encrypted backups. A refresh token that syncs to iCloud exists on every
device the user owns and in every backup. `AsyncStorage` is never used for a token; it is an
unencrypted file in the app container.

Web holds the ID token in memory only and never sees the refresh token — that lives in the
`HttpOnly` cookie from P4-18.

`storage.ios.ts` / `storage.web.ts` is on the sanctioned platform-split list in
[`../02-architecture/tech-stack.md`](../02-architecture/tech-stack.md) §3.5. Nothing else in
this group gets a platform file.

P4-22 replaces `NullTokenProvider` with a real `AuthTokenProvider` implementing the same
interface `packages/shared/src/api-client` already consumes. The API client itself does not
change: it asks for a token and sets `Authorization`. If the client needs modification beyond
swapping the provider instance, the Phase 1 seam is being violated.

P4-23 is the part that is easy to get subtly wrong:

- **Single-flight.** Concurrent callers awaiting one shared refresh promise. Without it, an
  app resuming from background fires six queries, all see an expired token, all call
  `REFRESH_TOKEN_AUTH` with the same refresh token, and with rotation enabled five of them get
  an invalid-token error and the user is signed out.
- **Refresh proactively** when the token has under 60 seconds remaining, not on `401`.
- **At most one retry** on a `401`: force one refresh, retry once, and on a second failure
  sign out and route to `(auth)/sign-in`. An unconditional retry loop against an expired
  session generates thousands of requests a minute.
- The retry must not replay a non-idempotent `POST` without its original `Idempotency-Key`.

**Tests.** Unit with a fake clock: ten concurrent calls with an expired token produce exactly
one refresh call. A `401` produces one refresh and one retry, and a second `401` produces a
sign-out and no third request. A rotated refresh token is persisted before the retry.

---

### P4-24 / P4-25 / P4-27 — Sign-up, sign-in, reset, sign-out

**Files.** `apps/mobile/src/app/(auth)/`.

**Approach.** Five screens: sign-up, confirm (6-digit code), sign-in, forgot-password and
reset-password. Sign-out is an action, not a screen. All five use `packages/ui` primitives and
the interaction contract's loading, empty and error states; none of them is a special case.

Details that are behaviour, not polish:

- The password field checks the candidate against a small local list of common passwords
  **before** submitting, so the user sees an inline message rather than a Cognito error. This
  is a UX affordance; the 12-character server policy is what is enforced.
- `preventUserExistenceErrors: true` means "wrong password" and "no such account" return the
  same generic error. The copy must not contradict that by saying "no account found" — that
  reintroduces the enumeration the setting removes.
- **A user who signed up with Apple has no password.** The reset screen must say
  `This account signs in with Apple.` rather than reporting success, because Cognito reports
  success for a password reset on a federated user and the user retries forever.
- The confirm screen offers `Resend code`, rate-limited client-side to one per 30 seconds, and
  states plainly that the message may be in spam — which, on Cognito's default sender, it
  frequently is (P4-09).

Sign-out follows [`../02-architecture/auth.md`](../02-architecture/auth.md) §3.4 in order:
`GlobalSignOut` (or `POST /public/v1/auth/logout` on web), clear the token store, then
`queryClient.clear()` including the **persisted** cache on disk — TanStack Query's persister
must be purged explicitly. Steps after the first run even if the first fails, because offline
sign-out must work. Device unregistration is Phase 5, since there are no push tokens yet.

**The signed-out routing state.** One guard at the router root, reading one session state of
`loading | signed-out | signed-in-onboarding | signed-in`. `loading` renders the splash and
nothing else — a flash of the sign-in screen before a stored token is read is the most common
symptom of getting this wrong. `signed-out` renders the `(auth)` group and no tab bar. A
`401` that survives one retry sets `signed-out` from anywhere in the app, and the screen it
came from is discarded, not left mounted behind a modal.

**Tests.** Maestro: sign up with a fresh address, read the code from a test mailbox, confirm,
land on onboarding. Playwright: the same on web, then reload the page and confirm the session
survives via the refresh cookie. A test that a cold launch with a stored token never renders
the sign-in screen.

---

### P4-26 — Sign in with Apple on the client

**Files.** `apps/mobile/src/features/auth/apple.ts`, `apps/mobile/app.config.ts`.

**Approach.** `expo-apple-authentication` for the native sheet on iOS; `expo-auth-session`
drives the Cognito hosted-UI leg on web. PKCE verifier and S256 challenge from `expo-crypto`.
Add `expo-apple-authentication` to the plugins array in `app.config.ts` so prebuild adds the
entitlement — without it the native sheet throws at runtime on a real build.

**Apple returns the user's full name only on the very first authorisation, never again.**
Capture `credential.fullName` on that first response and send it to `PATCH /v1/me`
immediately. If it is dropped there is no way to retrieve it short of the user revoking the
app in iOS Settings and starting over. Onboarding falls back to asking.

**Edge cases.**

- A Hide My Email user arrives with an `@privaterelay.appleid.com` address. It is a real,
  stable, deliverable address and works as an identity key. It will not match a guest record's
  real address — correct behaviour, and Phase 6's manual merge path is the fallback.
- The dev build's bundle identifier is `app.ordinarydays.ios.dev`, and the App ID registered
  for Sign in with Apple in P4-02 must include it. The prod identifier is Phase 5's problem
  and is the one that breaks in production only.
- **This cannot be tested on the simulator.** It needs a physical device and a real Apple ID.

**Tests.** Manual on a device: both the "share my email" and "hide my email" paths, and a
second sign-in confirming no name is returned and the stored display name persists. An
assertion that a first Apple sign-in with a name produces exactly one `PATCH /v1/me`.

---

### P4-28 — Onboarding after first sign-in

**Approach.** After the post-confirmation trigger has created the profile, the first sign-in
lands on onboarding with `onboardingState: 'new'`: confirm the timezone (defaulted from the
device, sent as `custom:tz` at sign-up and mirrored into `USER#/PROFILE`) and set a display
name, pre-filled from Apple's `fullName` when it was captured. Two fields, one screen, then
Today.

`USER#/PROFILE` is authoritative for both. `name` and `custom:tz` on the Cognito user are
user-writable and are display hints only; nothing reads them for a decision.

**Tests.** A user created through the real trigger reaches onboarding once and never again.
Changing the timezone in onboarding changes the agenda's day boundary on the next request.

---

### P4-29 / P4-30 — The dev-data question

> **Decision: `USER#usr_local_dev` is not migrated to a real Cognito `sub`. The local table
> is deleted and re-seeded.**

The reasoning, so it is not relitigated. The tenant key is the `usr_<ulid>` the
post-confirmation trigger generates; there is no correspondence between it and
`usr_local_dev`. Rewriting it would mean rewriting the partition key of every item in the
user partition, the `ownerId` on every `ACT#` partition, and the `gsi1pk` on every
`ActivityIndex` entry — a full-table rewrite, which is a migration script, a review, a dry
run and a verification pass. The data it would preserve is one founder's test fixtures. There
is also nothing deployed to migrate **from**: the dev DynamoDB table is created for the first
time in P4-07, empty. `od-main-dev` may be wiped freely until the first TestFlight build
([`../02-architecture/data-model.md`](../02-architecture/data-model.md) §9), and this is
before it.

**P4-29, the local reset:**

```bash
docker compose down -v
rm -rf .dynamodb-data
docker compose up -d
pnpm --filter @od/api ddb:create-table
pnpm --filter @od/api ddb:seed                 # seeds USER#usr_local_dev, unchanged
```

**Local development continues to work exactly as it did.** `AUTH_MODE=local` in
`services/api/.env.local`, `LocalIdentityProvider` returning `usr_local_dev`,
`NullTokenProvider` on the client, no network, no Cognito, no AWS credentials. That is the
default development loop after this phase as much as before it, and a change that breaks it is
a regression. The startup guard — throw when `AUTH_MODE === 'local'` and `STAGE !== 'local'` —
is what makes keeping it safe.

**P4-30, the deployed seed.** `infra/scripts/seed-dev.ts` gains `--stage` and `--email`:

```bash
pnpm --filter @od/infra exec tsx scripts/seed-dev.ts --stage dev --email founder@example.com
```

It resolves the real user with a direct `GetItem` on `EMAIL#<lowercased-email>` — never a
`Scan`, never a guess from Cognito — and **fails with a clear message if there is no profile**,
because that means nobody has signed up and confirmed yet. It refuses outright when
`--stage prod`. It is idempotent: re-running it updates the same deterministic item IDs rather
than creating a second copy of everything. It uses the same fixture module the local seed uses,
so the two data sets do not drift.

**Tests.** After a fresh sign-up in dev, running the deployed seed produces a populated Today
in the app. Running it twice produces the same item count. Running it with an unknown email
exits non-zero with a message naming the address. Running it with `--stage prod` exits
non-zero without making a single AWS call.

---

### P4-31 — `ObservabilityStack` on dev

**Approach.** Deploy the `od-alerts-dev` SNS topic, the email subscription, the alarms whose
resources now exist (API `5xx`, Lambda errors, Lambda throttles, DynamoDB user errors, the
Cognito trigger's error rate), and the dashboard. The SES bounce-rate and reminder-error alarms
have no resources yet and stay deferred to Phase 5, as its task list already records.

**Confirm the SNS email subscription.** An unconfirmed subscription means every alarm publishes
into nothing, and the failure is silent by construction. Verify with
`aws sns list-subscriptions-by-topic` showing a real subscription ARN rather than
`PendingConfirmation`.

Then prove one alarm end to end rather than assuming: force a `5xx` on dev with a deliberately
bad request against a throwaway route, and confirm the email arrives. An alarm that has never
fired is an alarm that has never been tested.

**Tests.** A CDK assertion that every alarm has an SNS action and that every log group has an
explicit retention. The rehearsal email is the evidence for the alarm path.

---

### P4-33 — E2E auth journeys against dev

**Approach.** Point Playwright at the local web build talking to the deployed dev API
(`E2E_BASE_URL=http://localhost:8081`, API base overridden to the `execute-api` endpoint) —
there is no hosted web build until Phase 5, and the journey being tested is the auth flow, not
the hosting.

| Journey | Runner |
| --- | --- |
| Sign up, confirm, land on onboarding, complete it, reach Today | Playwright |
| Sign in, reload the page, session survives via the refresh cookie | Playwright |
| Sign out, then a protected route redirects to sign-in | Playwright |
| Forgot password end to end with a real reset code | Playwright |
| Sign in, create a task, kill and relaunch the app, the task is there | Maestro |
| Sign in with Apple on a physical device | Manual, recorded |

Verification codes are read from a dedicated test mailbox with a deterministic address per run
(`founder+e2e-<runid>@…`), so a run never depends on a mailbox another run is using.
Plus-addressing is deliberately **not** normalised away by the pre-sign-up trigger, which is
what makes this work.

**Edge cases.** These tests create real Cognito users on every run. Add a cleanup step
deleting users matching the run prefix, and a nightly sweep for orphans — a pool that
accumulates thousands of test users eventually crosses the free MAU tier for no reason.

**Tests.** The suite is the test. It runs in `deploy-dev.yml` after the smoke tests.

## Acceptance criteria

1. `cdk bootstrap` is complete with the `odays` qualifier, and
   `aws cloudformation describe-stacks --stack-name CDKToolkit` reports `CREATE_COMPLETE`.
2. Billing → Free tier shows the account plan as **Paid**, and the zero-spend budget and the
   cost anomaly monitor both exist.
3. `AccountStack`, `DataStack`, `AuthStack` and `ApiStack` are all deployed to dev, and
   `cdk diff 'od-*-dev'` reports no changes against `main`.
4. `curl "$API_URL/v1/health"` against the `execute-api` endpoint returns `200` with a `sha`
   equal to the SHA of the commit on `main`.
5. A merge to `main` runs `deploy-dev.yml` to completion with no long-lived AWS credential:
   `aws sts get-caller-identity` inside the job reports `od-github-deploy-dev`.
6. `od-github-deploy-dev` cannot touch prod: an attempt to describe an `od-*-prod` stack from
   that role is denied.
7. The authenticated smoke test passes — a token minted for the CI test user reaches
   `GET /v1/me` with `200` — and a mutated token returns `401`.
8. Every row of the P4-15 divergence checklist has a recorded detection result in the pull
   request, and the API Gateway v2 event fixture is under test in CI.
9. The deployed function's environment contains no `DDB_ENDPOINT`, and `AUTH_MODE` is
   `cognito`.
10. Lambda init duration p95 is under **400 ms**, measured by the cold-start job, and the
    zipped bundle is under 5 MB.
11. A new user can sign up with email and password, receive a verification code, confirm, and
    sign in — on the iOS simulator and in a browser.
12. Immediately after confirmation, DynamoDB contains exactly one `USER#<usr_...>/PROFILE` and
    one `EMAIL#<address>/USER` for that user, and the next ID token carries a matching
    `custom:app_user_id`.
13. Re-triggering post-confirmation for the same user creates no second profile.
14. Sign in with Apple completes on a **physical device**, including the Hide My Email path,
    and the display name captured on first authorisation appears in `USER#/PROFILE`.
15. A password below 12 characters is rejected with an inline message before submission; a
    reset attempt on an Apple-only account says so rather than reporting success.
16. On iOS the refresh token is in the Keychain and readable only while unlocked; on web the
    refresh token is never present in `localStorage`, `sessionStorage` or any JavaScript-
    reachable value, and the cookie carries `HttpOnly` and `Secure`.
17. `POST /public/v1/auth/refresh` without an `X-CSRF-Token` header returns `403`; with a
    mismatched value returns `403`; with the matching value returns a new ID token and a
    rotated cookie.
18. Ten concurrent requests with an expired token produce exactly one Cognito refresh call, and
    a `401` that survives one retry signs the user out and routes to `(auth)/sign-in` with no
    third request.
19. Every request in the P4-19 cross-tenant table returns `404` for the second user, and no
    response body contains the first user's title, identifier or any evidence the resource
    exists.
20. Setting `/od/dev/auth/min-token-issued-at` to the current epoch second invalidates every
    existing token within five minutes with no deploy, and clearing it restores them.
21. `docker compose down -v` followed by the P4-29 sequence produces a working local
    environment, and `pnpm dev` with `AUTH_MODE=local` still runs the whole app against
    DynamoDB Local with no AWS credentials and no network.
22. Starting the API with `AUTH_MODE=local` and `STAGE=dev` throws at startup rather than
    serving a request.
23. `seed-dev.ts --stage dev --email <a confirmed address>` populates that user's Today;
    running it twice changes no item count; an unknown address and `--stage prod` both exit
    non-zero.
24. The `od-alerts-dev` SNS subscription is confirmed, and a deliberately triggered `5xx`
    produces an email.
25. `ObservabilityStack`'s CDK assertions pass: every alarm has an SNS action and every log
    group has an explicit retention.
26. The Playwright and Maestro auth journeys in P4-33 pass in `deploy-dev.yml`, and the E2E
    cleanup leaves no test users older than one day in the pool.
27. Cost allocation tags `Project`, `Stage` and `Component` are activated in the Billing
    console, and the account's month-to-date spend after the first week of deploys is under
    $1.

## Out of scope for this phase

| Do not build | Owned by |
| --- | --- |
| Domain registration, Route 53, ACM, `DnsStack` | Phase 5 |
| CloudFront, `WebStack`, S3 web hosting, the CSP | Phase 5 |
| The API custom domain — dev uses `execute-api` | Phase 5 |
| SES domain identity, DKIM/SPF/DMARC, Cognito email through SES | Phase 5 |
| Registering the sending domain with Apple's private email relay | Phase 5 |
| The prod environment: `od-*-prod` stacks, the prod deploy, prod data protections | Phase 5 |
| EAS builds, TestFlight, App Store Connect, prod bundle identifiers | Phase 5 |
| `SchedulerStack`, the reminder Lambda, push notifications, the inbox | Phase 5 |
| `DELETE /v1/me`, the 30-day purge, data export, the restore flow | Phase 5 |
| The `426 upgrade_required` kill switch | Phase 5 |
| The `deletedAt` check in the identity middleware | Phase 5 |
| Guest → account linking in the post-confirmation trigger | Phase 6 |
| The `GUESTEMAIL#` lookup partition | Phase 6 |
| `/public/v1/invites/*` and the public invite projection | Phase 6 |
| Participants, RSVP, and the participant branch of `assertActivityAccess` | Phase 6 |
| TOTP MFA enrolment UI — the pool is `OPTIONAL`, the settings screen is not built | Phase 9 |
| Any change to route handlers, services or repositories for auth | Nobody. The seam exists. |
| A custom Cognito auth domain | Not planned |
| SMS MFA | Not planned |
| AWS WAF | Only if the public surface is actually abused |

## Risks and gotchas

| Risk | Signal | Mitigation |
| --- | --- | --- |
| **Apple Developer enrolment is not complete in time** | P4-02 blocks, and P4-10, P4-26 and P4-33's Apple journey stall with it | P4-01 starts on day one of the phase. Individual enrolment is days; organisation enrolment with a D-U-N-S number is weeks. Nothing else in the phase depends on it, so starting early is free. |
| **Four phases of local-only code meets Lambda** | The first deploy `500`s on a path that has passed every local test | P4-15 is a task with its own budget, not a paragraph. Its eight items are run and recorded, not read. |
| An IAM denial that DynamoDB Local never produced | `AccessDeniedException` on a query that works locally | The integration suite is run once against the deployed table before the phase closes, and CloudWatch is queried for `AccessDenied` across the deploy window. |
| `DDB_ENDPOINT` leaks into the deployed environment | Every request times out at 15 s with no error naming the cause | A CDK assertion that it is absent from the environment map. |
| A module-scope promise is never awaited | An intermittent `500` on an unrelated request, with a stack pointing nowhere | Every module-scope promise gets a `.catch` at creation and is `await`ed at use, as the JWKS verifier already is. A lint rule on top-level `await`. |
| The `Set-Cookie` collapse under API Gateway v2 | Web sign-in works locally and silently loses the CSRF cookie deployed | The v2 event fixture is under test, and the cookie assertions run through the exported handler rather than `app.fetch`. |
| Someone "adds auth" to a route handler | A `getUserFromToken()` call appears inside a handler or a service | The seam is the design. P4-17 states plainly that a handler change means the plan is wrong, and review rejects it. |
| Cognito's default sender caps at 50 emails/day and lands in spam | Sign-up appears broken; the verification code never arrives | Known and accepted for dev. SES is Phase 5. The confirm screen says to check spam, and the E2E mailbox is checked directly rather than through a UI. |
| Refresh token rotation plus concurrent refreshes | The user is signed out on every app resume | Single-flight refresh, one shared promise, tested with ten concurrent callers. |
| The smoke test's `AdminInitiateAuth` needs a flow the public clients must not have | Either the smoke test cannot authenticate, or a dangerous flow is enabled on a shipped client | A separate `od-ci-dev` client, and an amendment to `auth.md` §1.7/§5.1 recording the third client ID in the verifier. |
| A cancelled CloudFormation deploy | A stack stuck in `UPDATE_IN_PROGRESS` needing manual recovery | `concurrency` without `cancel-in-progress` on `deploy-dev.yml`. Deploys queue. |
| E2E runs accumulate Cognito users | The pool fills with thousands of throwaway accounts and eventually crosses the free MAU tier | Per-run plus-addressed accounts, a cleanup step, and a nightly orphan sweep. |
| The dev pool's `RemovalPolicy.DESTROY` | A `cdk destroy` deletes every dev account and every profile they map to | Correct and intended; nothing of value is in a dev account. P4-29 is the recovery procedure, and prod carries `RETAIN` from Phase 5. |
| Canonical docs still describe the old `AUTH_MODE` values | An agent implements `dev-bypass` and an `X-Dev-User` header from `infrastructure.md` §6.2 | P4-17 amends `infrastructure.md` §6.2 and `testing.md` in the same pull request. There are two modes, not three. |
