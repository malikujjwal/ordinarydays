# Phase 5 — Ship v1 (private beta)

## Goal

At the end of this phase other people are using the app. Phase 4 left a deployed dev
environment reachable at an `execute-api` hostname with real Cognito sign-in; this phase
gives the system a name. `ordinarydays.app` is registered, `DnsStack` issues the
certificates, the API moves onto `api.ordinarydays.app`, and the web build serves from
CloudFront with a real Content Security Policy. A prod environment exists for the first
time, deployed from a tag behind an approval gate. An EAS pipeline produces signed iOS
builds that reach TestFlight, and testers who are not the founder install them. Reminders
are no longer local-only: EventBridge Scheduler fires a reminder Lambda that delivers a push
through Expo, honouring quiet hours, and the permission prompt is asked at the moment it
first makes sense rather than at first launch. The App Store requirements that are enforced
at review — Sign in with Apple, in-app account deletion, accurate privacy labels, a reachable
privacy policy — are all satisfied and verified, not assumed. A server-side kill switch can
force an upgrade when a shipped build is genuinely broken. Performance and accessibility have
been measured against the numbers in
[`../01-product/overview.md`](../01-product/overview.md) §7 rather than eyeballed.

## Prerequisites

| # | Item | Notes |
| --- | --- | --- |
| 1 | **Phase 4 complete: the dev environment is deployed and real auth works** | `AccountStack`, `DataStack`, `AuthStack` and `ApiStack` are live in dev, `deploy-dev.yml` is green, `AUTH_MODE=cognito`, and a real user can sign up, sign in, sign in with Apple, and sign out. This phase starts from a working deployed system, not from a laptop. |
| 2 | **Apple Developer Program membership active** | $99/yr, enrolled at the start of Phase 4 (P4-01). If it is not active on day one of this phase, the phase cannot finish. |
| 3 | A privacy policy and a support page written | Drafted from [`../02-architecture/security-privacy.md`](../02-architecture/security-privacy.md) §8.3. Both need public URLs before the App Store Connect record can be completed. |
| 4 | A dev Expo account and `EXPO_TOKEN` in GitHub secrets | Free plan is sufficient; see the queue caveat in [`../02-architecture/cost-model.md`](../02-architecture/cost-model.md) §3.3. |
| 5 | An `AASA` / universal-links decision | Deep links from push open specific screens; universal links are optional in v1 and the custom scheme is sufficient. |
| 6 | The Apple Services ID from P4-02 is editable | Phase 5 adds `ordinarydays.app` and the prod Cognito domain to the same Services ID. Both environments must be listed on it simultaneously. |

## Deliverables

- [ ] `ordinarydays.app` registered in Route 53, `DnsStack` deployed, both ACM certificates
      issued and DNS-validated.
- [ ] `api.ordinarydays.app` and `api.dev.ordinarydays.app` serving through API Gateway
      custom domains, and no shipped client using an `execute-api` hostname.
- [ ] SES domain identity verified with DKIM, SPF and DMARC passing, and Cognito sending
      verification and reset mail through it.
- [ ] The auth cutover: callback and logout URLs on the domain, the Apple Services ID
      carrying both environments, and the refresh cookie back to
      `SameSite=Lax; Domain=.ordinarydays.app`.
- [ ] `ordinarydays.app` serving the prod web build over CloudFront with the full CSP,
      HSTS and the response-headers policy.
- [ ] The prod environment deployed from a tag behind the GitHub environment approval, with
      prod smoke tests passing.
- [ ] `SchedulerStack` deployed: schedule group, reminder Lambda, and the API's role to
      create and delete schedules.
- [ ] Server-side reminder scheduling on every write that touches `schedule`, `recurrence`
      or a `REM#` row, **fanned out per user** from one unfiltered read of the activity
      partition, with the next-two-occurrences bound for series.
- [ ] Push delivery through Expo Push, device registration, quiet hours, the held digest.
- [ ] The notification permission pre-prompt and the deferred system prompt.
- [ ] The in-app notification inbox with no numeric badge anywhere.
- [ ] EAS build and submit pipeline; a signed production build on TestFlight with external
      testers.
- [ ] App Store Connect record complete: bundle identifier, screenshots, privacy nutrition
      labels, review notes, demo account.
- [ ] In-app account deletion with re-authentication, 30-day restore, and the purge job.
- [ ] Data export.
- [ ] `426 upgrade_required` kill switch, wired end to end.
- [ ] A performance pass against S1–S3 and the cold-start budget, with recorded numbers.
- [ ] An accessibility pass against
      [`../01-product/interaction-contract.md`](../01-product/interaction-contract.md) §6,
      with recorded results.
- [ ] Prod alarms live, an on-call runbook, and one rehearsed rollback.

## Tasks

| ID | Title | Area | Depends on | Parallel-safe | Size |
| --- | --- | --- | --- | --- | --- |
| P5-01 | Register `ordinarydays.app` and deploy `DnsStack` with both certificates | infra | — | no | M |
| P5-02 | API custom domains and the cutover off `execute-api` | infra | P5-01 | no | M |
| P5-03 | SES domain identity, DKIM/SPF/DMARC, and Cognito email delivery | infra | P5-01 | no | M |
| P5-04 | Auth cutover to the domain: callbacks, Apple Services ID, cookie scope | infra/api | P5-02, P5-03 | no | M |
| P5-05 | Prod web hosting and the custom domain | infra | P5-01 | no | M |
| P5-06 | Content Security Policy and response headers | infra | P5-05 | no | M |
| P5-07 | Prod data protections: PITR, deletion protection, backup drill | infra | P4-07 | yes | S |
| P5-08 | First prod deploy, prod smoke tests, and the release checklist | ci | P4-14, P5-05, P5-07 | no | M |
| P5-09 | Bundle identifiers, app icons, splash, `app.config.ts` for prod | mobile | P4-02 | no | M |
| P5-10 | EAS project, credentials, `eas.json` profiles | mobile | P5-09 | no | M |
| P5-11 | `mobile.yml`: EAS build and submit in CI | ci | P5-10 | no | M |
| P5-12 | `SchedulerStack`: group, reminder Lambda, roles | infra | P4-13 | no | L |
| P5-13 | The reminder Lambda | api | P5-12 | no | L |
| P5-14 | Reminder scheduling on API write paths | api | P5-13, P2-16 | no | L |
| P5-15 | Quiet hours, held notifications, the digest | api | P5-13 | no | M |
| P5-16 | Device registration and the Expo push token lifecycle | mobile | P1-08 | no | M |
| P5-17 | The permission pre-prompt and deferred system prompt | mobile | P5-16 | no | M |
| P5-18 | Notification preferences endpoints and screen | api/mobile | P1-07 | yes | M |
| P5-19 | The in-app inbox | api/mobile | P5-18 | no | L |
| P5-20 | Deep links from push to the exact screen | mobile | P5-16 | no | M |
| P5-21 | `DELETE /v1/me`: soft delete and immediate effects | api | P1-07, P4-08 | no | L |
| P5-22 | The 30-day purge job | api/infra | P5-21 | no | M |
| P5-23 | Account deletion UI with re-authentication | mobile | P5-21, P4-24 | no | M |
| P5-24 | Data export | api | P5-21 | yes | M |
| P5-25 | Privacy policy and support pages | web | P5-01 | yes | S |
| P5-26 | `426 upgrade_required` kill switch, server side | api | P4-17 | yes | M |
| P5-27 | The blocking upgrade screen, client side | mobile | P5-26 | no | S |
| P5-28 | App Store Connect app record | ops | P5-09 | no | M |
| P5-29 | Privacy nutrition labels | ops | P5-28 | no | M |
| P5-30 | Screenshots at the required sizes | ops | P5-10 | no | M |
| P5-31 | Review notes and the demo account | ops | P5-28, P5-08 | no | S |
| P5-32 | TestFlight: internal, then external | ops | P5-11, P5-28, P5-08 | no | M |
| P5-33 | Performance pass and the cold-start budget check | api/mobile | P2-11 | no | L |
| P5-34 | Accessibility pass | mobile | P2-22, P3-37 | no | L |
| P5-35 | Prod alarms, dashboard, and the on-call runbook | infra | P4-31, P5-13 | no | M |
| P5-36 | Rehearse a rollback | ops | P5-35 | no | S |
| P5-37 | Beta onboarding and the feedback channel | ops | P5-32 | yes | S |

P5-07, P5-25 and P5-37 are mechanical; follow the referenced sections.

Apple Developer Program enrolment is **not** a task here. It was started and completed in
Phase 4 (P4-01, P4-02), along with the App ID, the Services ID and the signing key. What
this phase adds to that setup is the production bundle identifier (P5-09) and the domain on
the Services ID (P5-04).

---

### P5-01 — Register the domain and deploy `DnsStack`

**Files.** `infra/lib/stacks/dns-stack.ts`, `infra/lib/config.ts`,
`infra/bin/ordinarydays.ts`.

**Approach.** [`../02-architecture/infrastructure.md`](../02-architecture/infrastructure.md)
§3.5 and §3.7. Check availability and price, then register through the console — the CLI path
needs a fully-formed contact JSON and the console validates it:

```bash
aws route53domains check-domain-availability --region us-east-1 --domain-name ordinarydays.app
aws route53domains list-prices --region us-east-1 --tld app --query 'Prices[0].RegistrationPrice'
```

Enable privacy protection and **auto-renew**. Registration creates the public hosted zone
automatically. A `.app` domain is on the HSTS preload list, so it is HTTPS-only by
construction.

Then set `apiDomain`, `domain` and `mediaDomain` in `EnvConfig` for both stages — they were
left unset in Phase 4 (P4-05) — and add `DnsStack` back into the deploy set. CDK looks the
zone up with `HostedZone.fromLookup` and DNS-validates both certificates automatically
because the zone is in the same account. Both live in `us-east-1`: mandatory for CloudFront.

**Edge cases.** `HostedZone.fromLookup` writes the result into `cdk.context.json`, which is
checked in. A stale entry after a zone is recreated produces a deploy that silently targets a
zone that no longer exists; `cdk context --clear` is the fix, and the file is reviewed like
any other.

Certificate validation records must stay in the zone forever — ACM re-validates on renewal.
Deleting them "because the certificate is issued" breaks the renewal a year later.

**Tests.** `aws acm describe-certificate` reports `ISSUED` for both; `dig ordinarydays.app NS`
returns the Route 53 nameservers; a CDK assertion that both certificates are in `us-east-1`.

---

### P5-02 — API custom domains and the cutover off `execute-api`

**Files.** `infra/lib/stacks/api-stack.ts`, `apps/mobile/app.config.ts`,
`.github/workflows/deploy-dev.yml`, `scripts/smoke.mjs`.

**Approach.** P4-05 made the custom domain conditional on `cfg.apiDomain`. Setting it is now
the whole change: `ApiStack` creates the `AWS::ApiGatewayV2::DomainName`, the API mapping and
the A record, for `api.dev.ordinarydays.app` and `api.ordinarydays.app`.

Then remove the `EXPO_PUBLIC_API_BASE_URL` override that Phase 4 used to point the client at
a generated hostname, so `app.config.ts`'s `API` map is once again the only place an API base
URL is written down. Update `scripts/smoke.mjs` and the E2E configuration to the named hosts.

**The `execute-api` endpoint keeps working after the custom domain exists**, which is the
trap: a client left pointing at it goes on working, and the mistake surfaces only when
someone later disables the default endpoint. Assert in CI that no committed file outside this
task's history contains the string `execute-api`.

**Edge cases.** An API mapping to the `$default` stage adds no path prefix, so no route
changes. The regional API Gateway domain needs an A **alias** record to the regional target,
not a CNAME, if the apex is ever used; these are subdomains, so either works — use the alias
for consistency with `WebStack`.

**Tests.** `curl https://api.dev.ordinarydays.app/v1/health` returns `200` with the deployed
SHA. A CI grep asserting no `execute-api` hostname in `apps/`, `packages/` or `services/`.

---

### P5-03 — SES domain identity and Cognito email delivery

**Files.** `infra/lib/stacks/dns-stack.ts` (the DNS records),
`infra/lib/stacks/auth-stack.ts` (the pool's email configuration).

**Approach.** Cognito has been sending through its built-in sender since Phase 4, capped at
**50 messages per day** from an `amazonaws.com` address that frequently lands in spam. That
is why [`../02-architecture/auth.md`](../02-architecture/auth.md) §1.8 specifies SES, and it
becomes possible the moment the domain exists.

1. Create the SES domain identity for `ordinarydays.app` and enable Easy DKIM. Publish the
   three CNAME records in the hosted zone from CDK, not by hand.
2. Publish SPF (`v=spf1 include:amazonses.com ~all`) and a DMARC record starting at
   `p=none; rua=...` so reports arrive before anything is enforced.
3. Switch the pool to `UserPoolEmail.withSES` with `fromEmail: no-reply@ordinarydays.app`,
   `replyTo: support@ordinarydays.app`, `sesRegion: us-east-1`.

**SES production access is not requested here.** Both environments stay in the sandbox until
there are guests to email, which is Phase 6 — the out-of-scope table already says so. In the
sandbox, SES sends only to verified addresses, so **every test and demo account's address
must be verified as an SES identity** before it can receive a verification or reset code. The
App Review demo account (P5-31) is the one that matters: an unverified demo address means a
reviewer cannot sign in.

**Edge cases.** DKIM validation can take up to 72 hours to propagate; verify status before
depending on it. Cognito's SES configuration requires the SES identity to be in the region
named in `sesRegion`, and a mismatch produces a pool update failure that names neither.

**Tests.** `aws sesv2 get-email-identity --email-identity ordinarydays.app` reports
`DkimAttributes.Status: SUCCESS`. Send a real sign-up through dev and check the received
message's headers for `dkim=pass`, `spf=pass` and `dmarc=pass`.

---

### P5-04 — Auth cutover to the domain

**Files.** `infra/lib/stacks/auth-stack.ts`, `infra/lib/config.ts`,
`services/api/src/routes/public/auth.ts`.

**Approach.** Four changes that all become possible at once, and all of which break sign-in
if only some of them ship.

1. **Callback and logout URLs.** Add `https://ordinarydays.app/auth/callback` to the web
   client and `https://dev.ordinarydays.app/auth/callback` to dev's. Keep
   `http://localhost:8081/auth/callback` on dev only. Add `ordinarydays://auth/callback` and
   `ordinarydays://auth/signout` to the prod mobile client.
2. **The Apple Services ID** gains `ordinarydays.app` and the prod pool's Cognito domain
   `od-prod.auth.us-east-1.amazoncognito.com`, plus the matching `idpresponse` return URL.
   The dev entries added in P4-02 stay. **Both environments must be listed simultaneously**,
   or whichever is missing fails with a redirect mismatch Apple reports unhelpfully.
3. **The refresh cookie goes back to its designed form.** Phase 4 used
   `SameSite=None; Secure`, host-scoped, because `localhost:8081` and an `execute-api`
   hostname are cross-site (P4-18). Now that the web app and the API share the registrable
   domain, set `SameSite=Lax; Secure; HttpOnly; Domain=.ordinarydays.app`. The attributes
   already come from `EnvConfig`, so this is a config change and a test, not a rewrite. The
   double-submit CSRF check stays regardless — `SameSite=Lax` alone does not protect a `POST`
   from a top-level cross-site navigation in every browser.
4. **CORS.** The origin allow-list becomes `https://ordinarydays.app` for prod and
   `https://dev.ordinarydays.app` plus `http://localhost:8081` for dev, with
   `credentials: true` and never `*`.

**Edge cases.** Removing `localhost` from the **prod** client's callback list is not optional.
A prod OAuth client that accepts a `localhost` redirect is an open door for a code
interception on a developer's machine.

Cognito rejects a callback URL list containing both `http` and `https` entries for the same
host, and rejects `http` for anything but `localhost`.

**Tests.** Sign in on `https://ordinarydays.app`, reload, and confirm the session survives.
Inspect the cookie: `HttpOnly`, `Secure`, `SameSite=Lax`, `Domain=.ordinarydays.app`. A
refresh without `X-CSRF-Token` still returns `403`. Apple sign-in works on the deployed web
build and on a TestFlight build, not only on dev.

---

### P5-05 — Prod web hosting and the custom domain

**Files.** `infra/lib/constructs/static-site.ts`, `infra/lib/stacks/web-stack.ts`.

**Approach.** `WebStack` has synthesised since Phase 0 and has never been deployed. Deploy it
for both stages: the private S3 bucket with Origin Access Control, the CloudFront
distribution, the cache and response-header policies, the URI-rewrite CloudFront Function for
Expo Router's static export, the A and AAAA records, and the media distribution.

The static export is uploaded by `BucketDeployment`, which handles the S3 sync and the
invalidation. Only HTML is invalidated; hashed assets under `/_expo/static/` are immutable by
name, so invalidating them wastes quota for nothing.

Restore the two steps P4-14 removed from `deploy-dev.yml`: `expo export --platform web` and
the Playwright run against `https://dev.ordinarydays.app`.

**Edge cases.** The bucket must be private with no public access and no website endpoint —
the origin is OAC, and a direct `GET` against the bucket URL must return `403`. Bucket
versioning is on, because the documented recovery for a bad web build is re-syncing the
previous version.

`Authorization` is **not** forwarded to the origin by CloudFront unless the origin request
policy says so. The web app calls `api.ordinarydays.app` directly rather than through the
distribution, so this does not bite here — but the media distribution's policy must forward
nothing it does not need, and the note is recorded because it is the classic failure when
someone later routes the API through CloudFront.

**Tests.** A direct `GET` on the S3 bucket URL returns `403`. `https://dev.ordinarydays.app`
serves the dev build and a deep link to a nested route returns the app rather than a
CloudFront `403`. For the media distribution: upload an attachment through the Phase 3
presign path against the deployed dev bucket, assert it renders at
`https://media.dev.ordinarydays.app/<key>`, and assert a direct `GET` against the media
bucket's S3 URL returns `403`. This is the first time either has been true — Phase 3 built
and tested that path against MinIO, which models neither CloudFront nor Block Public
Access.

---

### P5-06 — Content Security Policy and response headers

**Files.** `infra/lib/stacks/web-stack.ts` (response-headers policy).

**Approach.** The policy is in
[`../02-architecture/security-privacy.md`](../02-architecture/security-privacy.md) §4.3.
There has never been a deployed web build before this phase, so there is no report-only
period to inherit: ship the policy **report-only on dev** as soon as P5-05 lands, ship it
report-only on prod for **one week**, read the reports, and only then enforce. An enforcing
CSP that blocks the app's own bundle is a full outage with no server error to alarm on.

Also: HSTS with `includeSubDomains` and a 2-year max-age, `X-Content-Type-Options: nosniff`,
`Referrer-Policy: strict-origin-when-cross-origin`, and a `Permissions-Policy` denying
camera, microphone and geolocation.

**Edge cases.** Expo's static export inlines a small bootstrap script. Either hash it in the
policy or configure the export to emit it as a file — do not add `'unsafe-inline'`, which
removes most of the CSP's value. React Native Web's `Text` escapes by default and there is
no `dangerouslySetInnerHTML` and no `eval` in the codebase; a lint rule should keep it that
way.

**Tests.** A Playwright test asserting zero CSP violations in the console across the main
flows on the deployed prod build. A `curl -I` assertion on every header in `deploy-prod.yml`.

---

### P5-08 — The first prod deploy, prod smoke tests, and the release checklist

**Files.** `.github/workflows/deploy-prod.yml`, `scripts/smoke.mjs`,
`docs/05-operations/release-checklist.md`.

**Approach.** `deploy-prod.yml` exists and has never run. This is the first time
`od-*-prod` is deployed and the first time the approval gate is exercised.

The order matters, and the gate list is
[`../02-architecture/infrastructure.md`](../02-architecture/infrastructure.md) §7.7 in full:
the commit is on `main` and reachable from a `v*.*.*` tag; `ci.yml` passed on it; it is
already deployed to dev with dev smoke tests and E2E green; **a required reviewer approves the
`production` GitHub environment**, which is what mints the OIDC credential; tests run again on
the tagged tree; `cdk deploy` succeeds; prod smoke tests pass.

Prod needs its own dedicated smoke-test user and its own CI app client, created the same way
as dev's (P4-09), and its address verified in SES (P5-03) so it can be confirmed at all.

Push the first tag deliberately, on a day when watching it is fine. Confirm the environment's
five-minute wait timer and the required reviewer both fire — an approval gate nobody has ever
seen block anything is not known to work.

**Edge cases.** The prod pool is a **different pool**; a dev account is not a prod account.
Every account used for prod testing, review or demos is created fresh on prod.

The prod `RemovalPolicy` is `RETAIN` with deletion protection on the table (P5-07), so a
mistaken `cdk destroy` cannot take the data. Verify that before the first real user exists,
not after.

**Tests.** The prod smoke test asserts `200` and a matching SHA from
`https://api.ordinarydays.app/v1/health`, then an authenticated `GET /v1/me`. The release
checklist is walked once, end to end, and its result recorded.

---

### P5-09 — Bundle identifiers, icons, and prod app config

**Approach.** The identifiers are already set by profile in `app.config.ts`
([`../02-architecture/infrastructure.md`](../02-architecture/infrastructure.md) §6.4):

| Profile | Bundle identifier | App name | URL scheme |
| --- | --- | --- | --- |
| `prod` | `app.ordinarydays.ios` | `Ordinary Days` | `ordinarydays` |
| `dev` | `app.ordinarydays.ios.dev` | `Ordinary Days (dev)` | `ordinarydays-dev` |
| `local` | `app.ordinarydays.ios.local` | `Ordinary Days (local)` | `ordinarydays-local` |

`app.ordinarydays.ios` must match the App ID registered for Sign in with Apple in Phase 4
(P4-02) exactly. A mismatch breaks Apple sign-in in the production build only, which is the
worst place to discover it.

Also required in `app.config.ts` for prod:

- `ios.buildNumber` driven by EAS `autoIncrement`.
- `ios.infoPlist.NSCameraUsageDescription` and `NSPhotoLibraryUsageDescription` with
  specific, honest copy. Generic strings ("This app needs camera access") are a common
  rejection under Guideline 5.1.1.
- `ios.infoPlist.ITSAppUsesNonExemptEncryption: false` — the app uses only HTTPS, which is
  exempt. Omitting this makes every single upload ask an export-compliance question.
- **No ATS exception in prod.** The dev-only LAN exception must be conditional on the
  profile; shipping it is a rejection risk and a real weakening.
- App icon at 1024×1024 with no alpha channel and no transparency. An icon with alpha is
  rejected by the upload validator, not by review, and it fails after the build.

**Tests.** A unit test on `app.config.ts` asserting the prod branch produces the exact
identifier, no ATS exception, and `ITSAppUsesNonExemptEncryption: false`.

---

### P5-10 — EAS project, credentials, `eas.json`

**Approach.** `eas init` links the project. `eas credentials` generates and stores the
distribution certificate and provisioning profile on EAS's servers, so the founder never
manages a keychain. The push key (APNs) is also generated here — Expo Push needs it to
deliver to production builds.

`eas.json` profiles as in
[`../02-architecture/infrastructure.md`](../02-architecture/infrastructure.md) §6.4:
`development` (dev client, internal), `preview` (internal, dev profile), `production`
(prod profile, `autoIncrement`). `submit.production.ios.ascAppId` is filled after P5-28.

**Edge cases.** On the free EAS plan builds sit in a low-priority queue that can be hours
long. Plan the first production build for a day when waiting is acceptable, and never make
an infrastructure deploy depend on a build completing.

**Tests.** `eas build --platform ios --profile preview` produces an installable build;
install it on a device from the QR code and confirm it points at the dev API.

---

### P5-11 — `mobile.yml`: EAS build and submit in CI

**Files.** `.github/workflows/mobile.yml`.

**Approach.** [`../02-architecture/infrastructure.md`](../02-architecture/infrastructure.md)
§7.4: triggered by `workflow_dispatch` with a `profile` input (`preview` or `production`) and
by `v*.*.*` tags, which run `production`. The job checks out, sets up pnpm and `eas-cli` via
`expo/expo-github-actions` with `EXPO_TOKEN`, then runs
`eas build --platform ios --profile <profile> --non-interactive --no-wait`, with
`--auto-submit` added on the production profile.

Two flags carry the design:

- `--no-wait`: the free-plan queue can be hours long
  ([`../02-architecture/cost-model.md`](../02-architecture/cost-model.md) §3.3). The runner
  enqueues and exits rather than burning Actions minutes polling a queue, and the build link
  in the job summary is where you watch it.
- `--auto-submit` instead of a separate `eas submit` step: EAS chains the submission
  server-side when the build finishes, so a submission cannot be lost because a runner hit
  its timeout while the build sat in the queue. `submit.production.ios.ascAppId` comes from
  `eas.json` (P5-10, filled after P5-28); submission authenticates with the App Store Connect
  API key stored on EAS by `eas credentials`, so no Apple credential lives in GitHub unless
  `eas submit` is ever run from CI directly — then it is `APPLE_APP_SPECIFIC_PASSWORD`, as
  [`../02-architecture/infrastructure.md`](../02-architecture/infrastructure.md) §5.1 lists.
  (decision recorded here — raise in PR if wrong)

The workflow is wholly separate from `deploy-prod.yml`. A tag triggers both; neither waits
on the other, because an EAS queue must never block or fail an infrastructure deploy (§7.4).
A `concurrency` group serialises builds so a re-run cannot race the free quota. `EXPO_TOKEN`
is scoped to this workflow's environment, not repo-wide
([`../02-architecture/security-privacy.md`](../02-architecture/security-privacy.md) §7).

**Edge cases.** The tag path enqueues a build whether or not the `production` environment
approval for the AWS deploy has been granted — acceptable, because the build points at prod
*configuration* (P5-09), not at a specific deploy. Re-running the workflow on the same tag
produces a new `buildNumber` via `autoIncrement`, never a collision. There is no
`pull_request` trigger, so forks can never reach `EXPO_TOKEN`.

**Tests.** A `workflow_dispatch` run with `profile: preview` enqueues an EAS build whose URL
appears in the job summary. The production path is exercised once end to end when P5-32
distributes the first build. `actionlint` in `ci.yml` keeps the workflow parseable.

---

### P5-12 / P5-13 — `SchedulerStack` and the reminder Lambda

**Files.** `infra/lib/stacks/scheduler-stack.ts`,
`services/api/src/reminder/index.ts`.

**Approach.** A schedule group `od-reminders-{env}`. The API's execution role gets
`scheduler:CreateSchedule` and `scheduler:DeleteSchedule` scoped to that group, plus
`iam:PassRole` on a dedicated invocation role that may invoke only the reminder function.

Schedules are **one-time** (`at(...)`), with `ActionAfterCompletion: DELETE` so fired
schedules clean themselves up and the account quota is never approached, and
`FlexibleTimeWindow: OFF` — a reminder that fires ten minutes late is a broken reminder.

Schedule names are deterministic: `rem_<activityId>_<userId>_<reminderId>_<occurrenceDate>`,
so a delete never needs a lookup. **The `userId` is part of the name** because a reminder
belongs to a person: two participants on one dinner produce two schedules for one activity,
and deleting one must not touch the other.

The reminder Lambda: 512 MB, 30 s timeout, reserved concurrency 5. On invocation it reads
the activity and **that reminder's own user's** `DEVICE#` rows (access pattern 15), re-derives
the fire time from `date` + `time` + `timezone` to confirm it is still correct, applies that
user's quiet-hours setting, sends through Expo Push, and — for a recurring series — schedules
the same user's reminder for occurrence *n+2*.

**The suppression check (local-first delivery, P5-16's second amendment).** Before sending,
the Lambda compares each `DEVICE#` row's acknowledged `reminderStateVersion` and
`scheduledThrough` against the user's current version and this reminder's fire time. A
device that has provably armed this reminder locally — version current **and**
`fireAt <= scheduledThrough` — gets **no visible push**; a device with a stale version gets
a **silent data push** prompting re-sync, and the visible reminder only if it has not
re-acknowledged by fire time. The schedule itself is **always created**: an acknowledgement
can go stale after creation, so the timer must exist regardless. Quiet-hours evaluation uses
the **shared pure policy module** from `packages/shared` — the same function P2-57's local
scheduler imports — with parity tests over identical fixtures, never a second hand-written
engine. Tests: an acked device receives no visible push for an armed reminder (the
no-double-delivery assertion); a stale device receives data-push-then-backstop; a
no-permission device is always served by push.

**One schedule, many reminder sets.** `Activity` has no `reminders[]`; a reminder is a
`REM#<userId>#<reminderId>` item in the activity partition
([`../02-architecture/data-model.md#43-reminder`](../02-architecture/data-model.md#43-reminder)
§4.3, ADR-047). Every write path that (re)schedules reminders therefore **fans out per user**:
it reads the whole `ACT#<id>` partition once — access pattern 4b, the unfiltered read — groups
the `REM#` rows by `userId`, and creates one EventBridge schedule per row. It never reads one
array off `META`, and it never applies one user's offset to another user's push.

The fan-out is bounded by the participant cap and the per-user reminder cap: at most 50 × 3 =
**150 schedules per occurrence**, and for a series only the next two occurrences are ever
scheduled, so at most 300 live schedules per activity. Both caps are shared constants, not
numbers repeated here.

**Edge cases.**

- **Recurring series schedule only the next two occurrences' reminders at a time.** The
  Lambda schedules the following one after each fires — for **that user only**, so one user's
  quiet phone does not stall another user's series.
- A reminder more than **30 minutes** late at delivery is dropped rather than shown. A 6 PM
  reminder arriving at 9 PM is worse than nothing.
- A skipped or completed occurrence fires no reminder for **anybody**; completion is global
  (ADR-048), so one resolving write cancels every user's schedule for that occurrence. If it
  was resolved after the schedules were created, they are cancelled on the resolving write.
- If **a** user has no registered device, that user's reminder is skipped and everyone else's
  still fires. A participant with no device must not suppress the owner's push. Pure reminders
  write **no** inbox entry — Today already shows them.
- Multiple reminders on one activity fire independently and are not coalesced, and reminders
  belonging to **different users** are never coalesced under any circumstances — they are
  going to different phones.
- Quiet hours are read from the **recipient's** profile, not the owner's. Two participants in
  two timezones get two different held/delivered outcomes for one plan, which is correct.
- A participant leaving a plan deletes their `REM#` rows and their schedules. Nobody else's
  are touched.
- Expo Push receipts must be checked: a `DeviceNotRegistered` error deletes that `DEVICE#`
  row. Skipping this leaks pushes to devices that no longer exist and eventually gets the
  token throttled.

**Tests.** Unit on the fire-time derivation across a DST boundary using the same
`toUtcInstant` from Phase 2, asserting the reminder scheduler and the agenda agree at the
boundary. Integration with `aws-sdk-client-mock` asserting create/delete calls with the
deterministic name.

Plus the fan-out, which is the property this task exists to get right: an activity carrying
`REM#usr_a` at `-15` and `REM#usr_b` at `-120` produces **two** schedules with two different
fire times and two different names; the push sent at `-15` targets only `usr_a`'s devices;
**a participant's reminder never fires for another participant**, asserted on the recipient
list of every `sendPushNotificationsAsync` call. A second case: `usr_b` has no `DEVICE#` row,
and `usr_a`'s reminder still fires.

An end-to-end manual test on a device: set a reminder two minutes out, background the app,
receive the push, tap it, land on the right screen.

---

### P5-14 — Reminder scheduling on API write paths

**Files.** `services/api/src/services/reminderScheduling.ts`, called from the schedule,
patch, complete, skip, delete, participant-add and participant-remove paths.

**What to build.** The other half of P5-13: the code that creates and deletes EventBridge
schedules when the things a reminder depends on change. P5-13 owns what happens when one
fires; this task owns when they exist at all.

**The unit of scheduling is a `(reminder, occurrence)` pair, not an activity.** For every
write that changes a fire time, the service reads the `ACT#<id>` partition once — access
pattern 4b, keeping **all** `REM#` rows — and reconciles: delete the schedules that no longer
match, create the ones that are missing, leave the rest alone. Reconciling rather than
rebuilding matters because a participant added on Tuesday must not have the owner's Monday
reminder cancelled and re-created underneath them.

| Write | Effect |
| --- | --- |
| Date or time set, or changed | Every user's schedules for that activity are re-derived. |
| Date cleared | Every user's schedules are deleted. The `REM#` rows survive — an undated plan may hold reminders and they are picked up when a date lands. |
| `POST .../reminders` (P2-16) | One schedule for **that user**, for the next occurrence (and *n+2* for a series). |
| `DELETE .../reminders/:id` | That one schedule. Nobody else's. |
| A participant joins | If their own `defaultReminderOffset` is explicitly set, their own `REM#` row is created—including `0` for At the time—and that row alone is scheduled. Unset/Off creates none (P6-13). |
| A participant leaves, or is removed | Their `REM#` rows and their schedules are deleted. Nobody else's are touched. |
| Complete, skip, or cancel | **Every** user's schedules for that occurrence are cancelled, because completion is global (ADR-048). |
| Delete the activity | Every schedule for every user, in the same cascade as the partition. |

**Edge cases.**

- The reconcile is idempotent, because the schedule name is deterministic (P5-13) and
  `CreateSchedule` on an existing name is treated as a no-op rather than an error.
- Scheduling is **fire-and-forget from the handler's point of view**, on the same rule as
  email: the write succeeds, then schedules are reconciled, and a failure logs at `warn` and
  raises the alarm rather than failing the user's request. A reschedule that returns `500`
  because EventBridge was briefly unavailable would be a worse outcome than a late reminder.
- A fire time already in the past is not scheduled. This is common and not an error: somebody
  sets a date for this evening at 18:00 with a `-120` reminder at 17:00.
- The 62-day agenda cap does not apply. A reminder for a plan eleven months out is one
  one-time schedule and costs nothing until it fires.

**Tests.** Integration with `aws-sdk-client-mock`: a date change on a two-participant plan
where each participant has one reminder produces exactly two `CreateSchedule` calls with two
distinct names and two distinct fire times; deleting one user's reminder issues exactly one
`DeleteSchedule` and it names that user; a participant leaving cancels their schedule and no
other; completing an occurrence cancels **both** participants' schedules for it. A test that
the reconcile run twice with no intervening change issues zero calls the second time.

---

### P5-15 — Quiet hours, held notifications, the digest

**Approach.** Default window 22:00–07:00 local, enabled by default, read from the
**recipient's** profile. The behaviour table in
[`../01-product/notifications.md`](../01-product/notifications.md) §4 is normative, and the
two exceptions are the interesting part:

1. A **reminder for an activity that is itself inside the window** is delivered. A 6 AM
   flight reminder is exactly what quiet hours must not suppress.
2. A **plan-change or date-change notification for an activity starting in under 12 hours**
   is delivered immediately. That covers `plan_date_set`, `plan_date_changed`,
   `plan_changed` and `plan_cancelled` alike.

Everything else is held and delivered in the morning digest at the window's end. More than
three held items become one `held_digest` push. Inbox entries are written at their
**original** time regardless of holding, so the inbox reflects when things actually happened.

> **Decision:** the second exception is keyed on **when the activity starts**, not on which
> field changed. The previous rule delivered cancellations of imminent plans, and separately
> delivered a date change when the new date was today or tomorrow — the same situation
> described twice, with the cancellation half narrower for no reason. A plan moved from 8 AM
> to noon is exactly as actionable as one called off, and "today or tomorrow" is a calendar
> boundary rather than a notice period: a change at 23:50 to a plan at 09:00 the next day is
> ten hours away and held under the old rule. One clock threshold, one comparison.
> [`../00-open-decisions.md`](../00-open-decisions.md) item 36.

The 12-hour test uses the activity's `scheduledAtUtc` against the moment of the change. For an
all-day activity with no time, use 00:00 in the activity's own timezone.

**Tests.** Table-driven unit tests over the §4 matrix with a frozen clock, including a
reminder inside the window for an activity inside the window (delivered) and one for an
activity outside it (held). Plus the boundary, which is the part that regresses: a plan change
at 23:00 for an activity at 09:00 next day (10 hours → **delivered**); the same change for an
activity at 13:00 next day (14 hours → **held**); a cancellation and a date change at the same
offset produce the **same** outcome, asserted as a pair so the two cannot drift apart again; a
non-plan notification — an invitation, an RSVP, an added expense — at 11 hours is **held**,
because the exception is about plan changes and not about urgency in general.

---

### P5-16 — Device registration and the Expo push token lifecycle

**Files.** `apps/mobile/src/features/notifications/deviceRegistration.ts`, the sign-out
sequence in the auth feature, and the retirement of
`apps/mobile/src/features/reminders/localSchedule.ts`.

**Approach.** The endpoints exist from Phase 1 (P1-08): `POST /v1/me/devices` with
`{ expoPushToken, platform, deviceName }` and `DELETE /v1/me/devices/:deviceId`
([`../02-architecture/api-contract.md`](../02-architecture/api-contract.md) §2.1), writing
`USER#/DEVICE#` rows (access pattern 15, ADR-009). This task is the client half: obtain a
token with `expo-notifications` and keep the server's row true for the life of the install.

1. On permission grant (P5-17's pre-prompt → system prompt), call
   `getExpoPushTokenAsync` and `POST`; store the returned `deviceId` in SecureStore.
2. On every cold start where permission is granted, compare the current token against the
   last-registered one; if it rotated, `DELETE` the stored `deviceId`, `POST` the new token,
   and store the new id ([`../01-product/notifications.md`](../01-product/notifications.md)
   §6.1). The `POST` body carries no `deviceId`, so rotation is delete-then-create, not an
   upsert; the receipt cleanup in P5-13 is the backstop when the `DELETE` is lost offline.
   (decision recorded here — raise in PR if wrong)
3. On sign-out, `DELETE /v1/me/devices/:deviceId` **before** clearing tokens
   ([`../02-architecture/auth.md`](../02-architecture/auth.md) §3.4 step 2) — skipping this
   is how a shared or resold device leaks a stranger's reminders. An offline sign-out
   retries the `DELETE` opportunistically on next launch, same rule as `GlobalSignOut`.
4. Deletion on account deletion (P5-21) and on `DeviceNotRegistered` receipts (P5-13) is
   server-side and already specified.

**Reminder delivery is local-first; push is the updater and the backstop (second
amendment, 2026-08-17 — supersedes both earlier versions of this paragraph).** The first
version retired P2-57's local scheduling entirely; the second retained it for pending
intents only. Both solved duplicate delivery by removing the one delivery path that works
with no connectivity, which `notifications.md` §3.6 itself argues against: push is
at-most-once, and a reminder more than 30 minutes late is dropped rather than shown. A
planner must not require a network round trip at the exact firing minute for a time the
device has known for days.

The model (full contract in `notifications.md` §3.6):

1. **A synchronized device fires its own reminders** from P2-57's bounded projection —
   personal Tasks and shared Plans alike. No network at firing time.
2. **Push communicates what the device could not know** — a shared plan rescheduled, a
   reminder changed elsewhere — as a silent data push that triggers re-sync and re-arm.
3. **Push is the visible backstop** exactly when the server cannot establish local
   coverage: the device's acknowledged `reminderStateVersion` is stale, or the reminder
   fires beyond its acknowledged `scheduledThrough` horizon, or arming failed and was
   never acknowledged.

Duplicate delivery — the concern that motivated retirement — is prevented architecturally:
after verified arming the device acknowledges `{ reminderStateVersion, scheduledThrough }`
via `PUT /v1/me/devices/:deviceId/reminder-ack`, and the reminder Lambda (P5-13) suppresses
the visible push per device when the version matches and the fire time is inside the
horizon. The one residual is a narrow race — a reminder-relevant change landing minutes
before an armed reminder fires can produce one duplicate if the device has not re-acked —
accepted deliberately, because a duplicate beats a miss. This task still retires nothing at
install time; it registers the device and, with P5-13, turns the always-created EventBridge
schedules into backstop timers. The reminder controls and the no-permission behaviour are
unchanged; a device whose notification permission is revoked acknowledges nothing and is
served entirely by push.

**Edge cases.**

- `platform` is `'ios'` in v1; the web build never registers — there is no web push
  ([`../02-architecture/tech-stack.md`](../02-architecture/tech-stack.md) §"Push
  notifications").
- The token shape (`ExponentPushToken[…]`) is validated by a Zod schema in
  `packages/shared`, defined once and imported by both sides.
- A simulator returns no usable push token: `getExpoPushTokenAsync` failure is a silent
  no-op, never a crash, and the reminder controls stay usable.
- `deviceName` is stored for operator debugging only. There is no device-list screen in v1;
  do not build one.

**Tests.** Unit with `expo-notifications` mocked: grant → one `POST` with a valid token;
cold start with an unchanged token → zero calls; a rotated token → `DELETE` then `POST`;
sign-out → `DELETE` before the token store clears. Manual on a physical device: a dev-client
build registers and the `DEVICE#` row appears in dev; acceptance criterion 9 exercises the
full path.

---

### P5-17 — The permission pre-prompt

**Approach.** The system permission prompt is **never** requested at first launch. iOS
allows the system dialog once; asking it cold, before the user has any reason to want it, is
the single easiest way to permanently lose the channel.

The sequence from
[`../01-product/notifications.md`](../01-product/notifications.md) §6.1: no prompt on first
launch; at the first qualifying moment (setting a reminder, adding a participant, or opening
an invitation) show the in-app pre-prompt sheet with the exact copy in that section;
`Turn on` triggers the system prompt; `Not now` dismisses and reappears at the next
qualifying moment, at most once every 14 days.

If the system permission is denied, never re-prompt. Settings shows
`Notifications are off in iOS Settings` with a deep link, and reminder controls stay usable
— they simply do not fire.

**Tests.** Maestro: launch a clean install, reach Today, assert no system dialog appeared;
set a reminder, assert the pre-prompt appears; tap `Not now`, set another reminder
immediately, assert it does not reappear.

---

### P5-18 — Notification preferences endpoints and screen

**Files.** `services/api/src/routes/me/notificationPreferences.ts`,
`packages/shared/src/notifications.ts` (category keys, defaults, schema — the module
[`../02-architecture/api-contract.md`](../02-architecture/api-contract.md) §2.12 names),
the Settings → Notifications screen.

**Approach.** `GET`/`PATCH /v1/me/notification-preferences` over the eight category keys in
[`../01-product/notifications.md`](../01-product/notifications.md) §2 plus quiet hours (§4).
Defaults: everything on except `plan_activity` and `unsettled`; quiet hours enabled,
22:00–07:00 local.

Storage is **fields on the `USER#<u>/PROFILE` item, not a new row**: a sparse
`notificationPrefs` override map and a `quietHours` `{ enabled, start, end }` object.
Defaults live in `packages/shared/src/notifications.ts` beside the category keys and are
never materialised into storage until the user changes a toggle, so a future default change
reaches everyone who has not touched it. `GET` returns the full effective map with defaults
merged, so no client re-derives them. This is an additive schema change; update the `User`
shape in [`../02-architecture/data-model.md`](../02-architecture/data-model.md) §4 in the
same PR. (decision recorded here — raise in PR if wrong)

The screen: Profile → Settings → Notifications. All eight toggles with §2's labels, and the
quiet-hours control. All eight ship now even though only `reminders` has a producer before
Phase 6 — the screen is the product doc's shape, and Phases 6 and 7 then land without a
settings change. When iOS permission is denied, this screen carries the
`Notifications are off in iOS Settings` line and deep link (§6.1); the toggles stay
editable.

**Edge cases.**

- Turning a category off suppresses push **and** email, never the inbox entry (§2). The
  enforcement lives in the send paths (P5-15 and the Phase 6/7 producers); this task's
  schema is what they consult.
- Quiet-hours values are local wall-clock `HH:mm` and the default window crosses midnight.
  The recipient's timezone comes from their own profile, evaluated per recipient (P5-15).
- `PATCH` is partial. An unknown category key or a malformed time is
  `400 validation_failed`. The Zod schema is defined once in `packages/shared` and imported
  by both API and client — never redefined.
- Per-plan and per-list mute are per-activity state, not categories; they belong to Phase 6,
  not this screen.
- Web shows the same screen with the §6.2 line `Push notifications are available in the iOS
  app.`, and the category toggles still gate the web toast surface.

**Tests.** Integration: a fresh user's `GET` returns exactly the §2 defaults; `PATCH` on one
toggle round-trips and leaves the other seven untouched on the stored item; disabling quiet
hours makes P5-15's decision function deliver inside the window; an unknown key and `25:00`
both `400`. Playwright: toggle, reload, still toggled.

---

### P5-19 — The in-app inbox

**Files.** `services/api/src/routes/notifications.ts`,
`services/api/src/services/notificationInbox.ts`, the repository layer,
`apps/mobile/src/features/inbox/`.

**Approach.** The three endpoints from
[`../02-architecture/api-contract.md`](../02-architecture/api-contract.md) §2.12 —
`GET /v1/notifications?cursor=`, `POST /v1/notifications/:id/read`,
`POST /v1/notifications/read-all` — with the behaviour table in
[`../01-product/notifications.md`](../01-product/notifications.md) §5 as the normative spec.

Storage is **a new sort-key prefix in the user partition, not a new table and not a new
GSI**: `USER#<userId>` / `NTF#<createdAtIso>#<notificationId>`, entity `Notification`,
carrying `{ key, title, body, route, refs, createdAt, readAt?, ttl }`. Newest-first is
`Query pk, sk begins_with NTF#, ScanIndexForward=false`, with the cursor as the exclusive
start key. Add the item to
[`../02-architecture/data-model.md`](../02-architecture/data-model.md) §3.2 and the access
pattern to §5 **in the same PR** — that document requires the row before the code exists.
Retention is 90 days via the item `ttl` set at write; §5 says "removed by the maintenance
job", and DynamoDB TTL is that job — a sweep would need per-user iteration or a `Scan`,
which is banned. (decision recorded here — raise in PR if wrong)

The writer is one service function, `writeInboxEntry`, and **in this phase it has almost no
callers**: reminders never write inbox entries (§5), and every inbox-writing catalogue key
in §7 belongs to sharing (Phase 6) or expenses (Phase 7). Phase 5 ships the storage, the
endpoints and the screen so that `held_digest`'s tap target exists (P5-20) and Phase 6
producers call one function rather than inventing their own.

The screen: Profile → `Notifications`, with an unread **dot** on the Profile entry point —
derived from any unread entry in the first page — and **no numeric badge anywhere**
(acceptance criterion 17). Entries group by day (`Today`, `Yesterday`, then dates),
client-side. Tapping an entry marks it read and navigates via its `route` to the thing it is
about — never to a nested detail of the notification itself. Empty state: `Nothing new.` —
which is what every v1 beta user sees, correctly.

**Edge cases.**

- Entries are written at their **original** time whether the push was sent, held by quiet
  hours, or suppressed by a category toggle (§5, P5-15). Write the inbox entry first, decide
  about the push second.
- The tap's only write is the entry's own `readAt` — the §5 rule "read when tapped" — and
  the navigation target is never mutated.
- The inline `Going · Maybe · Decline` on invitation entries is Phase 6; the row component
  leaves the slot, renders nothing.
- `held_digest` routes here but is itself push-only — it writes no inbox entry (§7).
- `read-all` is idempotent and bounded by the 90-day retention; it pages through unread
  entries rather than assuming one write.

**Tests.** Integration: three written entries return newest first; the cursor pages
correctly; `:id/read` sets `readAt` and a second call is a no-op success; a reminder firing
end to end writes zero `NTF#` rows; every written item carries `ttl = createdAt + 90 days`.
Maestro/Playwright: the empty state shows `Nothing new.`; with seeded entries, a tap
navigates to the referenced plan and the Profile dot clears; no numeric badge exists on any
screen.

---

### P5-20 — Deep links from push to the exact screen

**Files.** `apps/mobile/src/features/notifications/pushRouting.ts`, wiring in the root
layout; the route-builder helper in `packages/shared/src/notifications.ts` used by the
reminder Lambda.

**Approach.** Every push carries `data.route`, an Expo Router path, and tapping it opens
exactly that screen — [`../01-product/notifications.md`](../01-product/notifications.md) §8:
a push that opens Today is a bug, except `held_digest`, which opens the inbox. This phase's
senders set it: the reminder Lambda (P5-13) sends the activity-detail route for
`/activity/<activityId>`; the quiet-hours digest (P5-15) sends the inbox route. Phase 6 keys
reuse the same field and the same helper.

Client side: `addNotificationResponseReceivedListener` handles taps while the app is warm or
backgrounded; `getLastNotificationResponseAsync` handles taps that cold-start it. On cold
start the route is queued until the root navigator has mounted and the session has resolved
— navigating before auth hydration lands on the sign-in redirect and loses the route. Routes
are validated against an allow-list of app route patterns before navigating; anything else
falls back to Today with a `warn` log. The payload comes from our own Lambda, but the
allow-list is what stops a future producer shipping a route the installed build cannot
render.

The transport is the custom scheme per profile — `ordinarydays`, `ordinarydays-dev`,
`ordinarydays-local` (P5-09) — so a dev push can never open the prod app. **No AASA file and
no universal links in v1**; prerequisite 5 records that decision and nothing here needs
them.

**Edge cases.**

- Signed out at tap time: proceed to sign-in and **drop** the pending route rather than
  replaying it after authentication — a deep link firing minutes later, mid-onboarding, is
  more confusing than landing on Today. (decision recorded here — raise in PR if wrong)
- The routed activity may be gone — deleted, or the user removed from it. The detail
  screen's ordinary not-found handling owns that; the router does not pre-check.
- A notification received in the **foreground** is not a tap: the handler shows the banner
  per the notification-handler config and never auto-navigates. Navigation happens only on a
  response.
- Tapping a reminder push opens detail read-only. Nothing is completed, snoozed or mutated
  by the tap (interaction rule: tap opens detail, never mutates).

**Tests.** Unit on the route mapper: every v1 catalogue key that pushes produces an
allow-listed route; `held_digest` maps to the inbox; a malformed or unknown route falls back
to Today. Scheme routing is verified with `xcrun simctl openurl` for the same paths. The
real push tap cannot be automated; acceptance criterion 9's manual device pass — reminder
two minutes out, background, tap, land on the activity — is the end-to-end check.

---

### P5-21 / P5-22 / P5-23 — Account deletion

**This is enforced at App Store review.** Guideline 5.1.1(v): any app supporting account
creation must let the user **initiate deletion from within the app** — not a support email,
not a web form.

**Approach.** `DELETE /v1/me`. Soft delete now, hard purge after 30 days, exactly as
[`../02-architecture/auth.md#8-account-deletion`](../02-architecture/auth.md#8-account-deletion)
specifies.

Immediately on request, all six steps: set `deletedAt`, `purgeAfter` and `ttl` on the
profile; `AdminDisableUser` then `AdminUserGlobalSignOut`; delete every `DEVICE#` row so
push stops; delete every EventBridge schedule with the user's prefix; leave every invite
they created **live** (soft-delete is invisible to everyone but the owner — auth.md §8
decision; revocation and cancellation happen only at purge); and make the auth middleware
`401` any token whose profile has `deletedAt` set.

In the app: Settings → Account → Delete account, a confirmation screen stating plainly what
is deleted, what is retained and why, and that signing in within 30 days restores the
account. **Requires re-authentication immediately before the call** — a session left open on
an unlocked device must not be able to delete the account.

At purge, the retention rules matter and must be in the privacy policy: participant rows on
**other people's** activities are retained as guest-style records with the display name and
without the email or user link; expenses the user was part of are retained with the person
reference and settled state intact; and the user's own shared plans with surviving
participants are cancelled with notification and then retained anonymised (`Deleted user`)
as read-only history rather than deleted. Deleting your account cannot delete someone
else's plan, rewrite a shared expense split so the arithmetic stops reconciling, or make
their settled history reopen.

Before deleting anything, the checkpointed purge job splits the financial footprint per
auth.md §8: rows touching a shared plan with surviving participants are retained anonymised
and never unwound; only Settlements concerning nobody but the deleted account (solo plans,
or shared plans with no survivor) get exact whole-Settlement Undo — debtor/reverse-map
pairs conditionally cleared, Expense roll-ups recomputed, audit and locator rows deleted —
before their Activities are removed. A cross-Activity Settlement spanning both halves is
treated as retained, never shortened. No destructive partition delete runs until this
cleanup succeeds, so a retained Expense cannot point to missing audit history.

> **Deletion tombstones — handed over by P2-49 (2026-08-17).** Phase 2.6 writes an
> `ACT#<activityId>` / `TOMBSTONE` row in every activity delete, so a create replayed from an
> offline queue cannot resurrect a deleted activity
> ([`../02-architecture/data-model.md#4-entities`](../02-architecture/data-model.md) §4, §8).
> **The purge must remove them with everything else.** They are the one row in an activity's
> partition that outlives `META`, so a cascade written against "delete the partition" catches
> them and a cascade written against "delete what `META` pointed at" does not. Their `ttl`
> makes this a tidiness obligation rather than a correctness one — a missed tombstone expires
> on its own — but a purge that leaves rows behind in a partition it claims to have emptied is
> the kind of gap the checkpointed traversal above exists to close. P2-49 could not do this
> itself: `DELETE /v1/me` does not exist in Phase 2 and is deliberately absent rather than
> stubbed.

The Phase 5 purge already follows every owner-role `USER#/LIST#` pointer and runs the ordinary
List cascade, because canonical List `META` and items live outside the user partition. Phase
6 extends that same checkpointed traversal: owned shared Lists lose every member pointer,
invited/active reciprocal `LLINK#` and viewer `LNK#`; for a member-role pointer on someone
else's List, remove the deleting user's `MEMBER#`, both reciprocal links and viewer links and
decrement `memberCount`. Preserve every other-owned ListItem and the other owner's
`PERSON#`, clearing its `linkedUserId`. Cross-partition checkpoints finish before `USER#`
deletion.

**Edge cases.** The purge runs from the daily maintenance sweep on `purgeAfter < now` **or**
from a TTL Streams handler. Streams are Phase 7, so in Phase 5 use a daily EventBridge rule
invoking a maintenance Lambda. S3 objects under `u/<userId>/` are batch-deleted and then
verified — an unverified batch delete leaves orphan objects paying storage indefinitely.

**Tests.** Integration: after `DELETE /v1/me`, the previous ID token `401`s, device rows are
gone, schedules are gone, and the Cognito user is disabled. Signing in within the window
routes to the restore screen and restores fully. A purge run against a profile with
`purgeAfter` in the past removes every item in the user's partitions, every activity they
own, and their `EMAIL#` row, and leaves participant rows on another user's activity in
place with the email removed. A fixture with Settlements on both owned and other-owned
Activities proves the checkpointed unwind runs first, leaves no dangling reverse map or
locator, and resumes idempotently after interruption. A private-List fixture proves Phase 5
leaves no orphan `LIST#` partition. After Phase 6, a shared-List fixture also proves an owned
List cascade removes every member pointer/`LLINK#`/`LNK#`; membership on an other-owned List
is removed with one counter decrement while its items and owner-scoped Person survive; a
killed purge resumes without double-decrementing.

---

### P5-24 — Data export

**Files.** `services/api/src/routes/me/export.ts`,
`services/api/src/services/exportUser.ts`; one `Export my data` row on P5-23's
Settings → Account screen, above `Delete account`.

**Approach.** `GET /v1/me/export` generates a JSON file of the user's activities, lists and
settings; the object remains available for 24 hours and each request returns a fresh
short-lived presigned link
([`../02-architecture/api-contract.md`](../02-architecture/api-contract.md) §2.1). It reuses
the purge's partition walk (P5-22), which is why
[`../02-architecture/security-privacy.md`](../02-architecture/security-privacy.md) §8.2
calls it nearly free to build: the `USER#` partition (profile, preferences, people, index
entries), each owned `ACT#` partition via the `IDX#` pointers (activity, occurrences, the
caller's **own** `REM#` rows), each owned `LIST#` partition via the `LIST#` pointers (meta
and items). Documented access patterns only — no `Scan`. Money fields, when they exist
(Phase 7), export as stored integer cents, never floats.

Output is one document — `{ exportedAt, schemaVersion, profile, activities, lists }` —
written to the media bucket under `tmp/export/<userId>/<ulid>.json`. Under `tmp/`
deliberately: the existing lifecycle rule already expires `tmp/` objects after one day
([`../02-architecture/aws-services.md`](../02-architecture/aws-services.md) §1.5), which
matches the 24-hour link with no new configuration and no new cost — the object is a few
kilobytes inside the S3 free-tier bucket. Generation is synchronous in the request: at beta
scale the walk is a handful of queries, and an async job buys nothing until export size
threatens the Lambda timeout. (decision recorded here — raise in PR if wrong)

Export is offered **alongside deletion** (§8.2 — it removes the "I cannot leave" objection),
which is why the row lives on the same Account screen. Tapping it calls the endpoint and
opens the returned link.

**Edge cases.**

- **A presigned URL signed with the Lambda's temporary credentials dies when those
  credentials expire**, which can be sooner than 24 hours. The contract's 24 hours is
  honoured as the *object's* availability (the `tmp/` lifecycle); the link is minted on
  request and opened immediately, and re-tapping the row mints a fresh link. A literally
  24-hour-valid URL would need a dedicated long-lived signing credential — raise in the PR
  before adding one. (decision recorded here — raise in PR if wrong)
- The media distribution's OAC can read the whole bucket, so the key's unguessability is the
  same ULID-under-a-per-user-prefix argument as image keys — and unlike an image, the object
  is gone in a day.
- The export contains only the caller's own data. Trivially true in v1 (sharing is
  Phase 6), but the walk must already exclude other users' `REM#` rows — the same
  projection rule as access pattern 4 — so Phase 6 does not silently turn the export into a
  leak.
- Attachment **keys** are included where activities reference them; the image bytes are not.
  A zip with media is not in v1.
- Add `GET /v1/me/export` to the rate-limit table in
  [`../02-architecture/api-contract.md`](../02-architecture/api-contract.md) §4 at
  **5 / hour** in the same PR — each call is an S3 `PUT` plus a partition walk, and the
  general 120 req/min limit alone would let one client generate hundreds of exports.
  (decision recorded here — raise in PR if wrong)

**Tests.** Integration against MinIO: a seeded user with two activities (one recurring, with
an occurrence override and a reminder) and one list with items produces an export containing
all of them and **nothing** belonging to a second seeded user; the object lands under
`tmp/export/<userId>/`; the returned URL `GET`s `200`; only the caller's reminder rows
appear. Acceptance criterion 21 is the deployed check.

---

### P5-26 / P5-27 — The force-upgrade kill switch

**Approach.** The client sends `X-Client-Version` as `ios/1.4.0` or `web/1.4.0` on every
request (already required by
[`../02-architecture/api-contract.md#1-shape`](../02-architecture/api-contract.md#1-shape)).
A middleware compares it against a minimum-supported version held in SSM Parameter Store at
`/od/{stage}/client/min-version`, read with the standard 5-minute cached `getSecret` path so
flipping the switch propagates in five minutes with no redeploy.

Below the minimum → `426 upgrade_required` with `details: [{ path: 'updateUrl', message:
'<App Store URL>' }]`. The client renders a blocking screen: `Update Ordinary Days to keep
going.` with an `Update` button.

**Use it for genuinely broken builds only.** A version gate used for feature rollout trains
users to expect forced updates and burns the mechanism.

**Edge cases.** A malformed or absent `X-Client-Version` must **not** be blocked — treat it
as unknown and allow. Blocking on a header the client failed to send is a self-inflicted
outage. The check must run before any expensive work but after auth, so an unauthenticated
caller cannot probe it.

**Tests.** Integration: a version below the minimum `426`s with the URL; at or above passes;
absent passes. A Maestro test of the blocking screen with a stubbed response. Flip the
parameter on dev and confirm the change takes effect within five minutes without a deploy.

---

### P5-28 — App Store Connect app record

**Approach.** developer.apple.com → App Store Connect → My Apps → **+** → New App.

| Field | Value |
| --- | --- |
| Platform | iOS |
| Name | `Ordinary Days` — must be globally unique across the App Store; check availability before committing to it |
| Primary language | English (U.S.) |
| Bundle ID | `app.ordinarydays.ios`, selected from the registered identifiers — it **cannot be changed** after the first build is uploaded |
| SKU | `ordinarydays-ios-1` — internal only, never shown |
| User access | Full |
| Primary category | Productivity |
| Secondary category | Lifestyle |
| Age rating | 4+, answering every questionnaire item honestly — the app has no user-generated public content, no gambling, no unrestricted web access |
| Price | Free |
| Availability | Start with your own country only for the beta; widen at public launch |

Record `ascAppId` (the numeric Apple ID shown on the app's page) into
`apps/mobile/eas.json` under `submit.production.ios.ascAppId`.

Also required before submission:

- **Privacy policy URL** — a real, reachable page (P5-25). Apple checks it.
- **Support URL** — a real page with a working contact route.
- **Copyright**, **Promotional text**, **Description**, **Keywords**.
- **App Review contact**: name, phone, email that a reviewer can actually reach.

---

### P5-29 — Privacy nutrition labels

**Approach.** App Store Connect → App Privacy. Declare exactly what the app collects, no
more and no less. Under-declaring is a rejection; over-declaring scares users away for no
reason. The authoritative list is
[`../02-architecture/security-privacy.md`](../02-architecture/security-privacy.md) §8.1;
the mapping for this app:

| Data type | Collected | Linked to identity | Used for tracking | Purpose |
| --- | --- | --- | --- | --- |
| Email address | **Yes** | Yes | No | App functionality (account, invitations) |
| Name | **Yes** | Yes | No | App functionality (display name on shared plans) |
| User content — photos | **Yes** | Yes | No | App functionality (attachments) |
| User content — other (activity titles, notes, lists) | **Yes** | Yes | No | App functionality |
| Contacts | **No** | — | — | The app never reads the device address book |
| Precise or coarse location | **No** | — | — | Location is a free-text label; there is no geocoding and no location permission |
| Identifiers — device ID | **Yes** | Yes | No | The Expo push token, for reminders only |
| Usage data, diagnostics, purchases, financial info, health, browsing history, search history, sensitive info | **No** | — | — | None are collected in v1 |

`Used for tracking` is **No** across the board: there is no advertising SDK, no analytics
SDK, no third-party identifier, and nothing is shared with a data broker. That means the app
does **not** need `App Tracking Transparency` and must not present the ATT prompt.

**Edge cases.** Adding an analytics SDK later changes this table and requires a new
submission with updated labels. Note it in the phase-5 scope guard so nobody adds one
casually.

**Tests.** A checklist review against the actual code: grep for every third-party SDK in
`apps/mobile/package.json` and confirm each is accounted for.

---

### P5-30 — Screenshots at the required sizes

**Approach.** App Store Connect requires screenshots for the largest supported iPhone display
class; other sizes are scaled from it automatically, but supplying the 6.5-inch set as well
avoids awkward scaling artefacts.

| Display class | Pixel dimensions (portrait) | Required |
| --- | --- | --- |
| 6.9-inch (iPhone 16 Pro Max class) | 1320 × 2868 | **Yes** |
| 6.5-inch (iPhone 11 Pro Max / XS Max class) | 1242 × 2688 | Recommended |
| 12.9-inch iPad Pro | 2048 × 2732 | Only if the app is offered on iPad |

> **Decision:** v1 ships **iPhone only**. The app runs on iPad through compatibility mode
> and the responsive layout already handles the width, but shipping an iPad build means
> iPad screenshots, iPad-specific review, and iPad layout bugs at exactly the wrong time.
> Set `ios.supportsTablet: false` and revisit after the beta.

Between three and ten screenshots per size. Capture them from the simulator at the exact
device class with real seeded data — not lorem ipsum, and not an empty state. The five that
tell the story:

1. Today with the timed sequence and all three untimed groups populated (the worked example day is ideal).
2. Global Add showing the three explicit destinations: **Task**, **Plan**, and **List item**.
3. A plan detail with prep tasks and a list.
4. A list with a scheduled item showing its state line.
5. The watchlist with progress.

No device frames, no marketing overlay text, no claims. Plain screenshots are honest and
never get rejected for a mismatch between the marketing image and the app.

**Edge cases.** A screenshot showing a feature that does not exist in the submitted build is
a rejection under Guideline 2.3.3. Capture from the exact build being submitted.

---

### P5-31 — Review notes and the demo account

**Approach.** App Store Connect → App Review Information.

- **Sign-in required:** Yes. Provide a **demo account** with a real email and password, in a
  state a reviewer can use: pre-populated with a handful of activities across several types,
  at least one recurring task, one list with a scheduled item, and one plan with prep tasks.
  An empty demo account leads a reviewer to conclude the app does nothing.
- The demo account must be on **prod**, must not expire, and must not require an email
  verification code the reviewer cannot receive. Pre-confirm it.
- **Notes for the reviewer**, covering:
  - What the app is, in two sentences.
  - Where account deletion lives: `Settings → Account → Delete account`. State it explicitly
    — reviewers check this and not finding it is a rejection.
  - That Sign in with Apple is offered alongside email and password.
  - That the app collects no location and shows no ATT prompt because it does not track.
  - That push notifications are reminders the user creates, and how to trigger one quickly
    (create a task two minutes out).
  - That the app has no in-app purchases and no external payment.

**Common rejection reasons for an app of this shape**, each with what prevents it:

| Guideline | Rejection | Prevention |
| --- | --- | --- |
| 5.1.1(v) | Account creation with no in-app deletion path | P5-21/P5-23, and the review note naming the exact path |
| 4.8 | A third-party sign-in without an equivalent privacy-preserving option | Sign in with Apple shipped in Phase 4, re-tested here on the production build |
| 2.1 | Incomplete submission: a demo account that does not work, or an empty one | Pre-seeded, pre-confirmed, non-expiring demo account |
| 5.1.1(i) | Vague permission strings | Specific `NSCameraUsageDescription` / `NSPhotoLibraryUsageDescription` copy naming the feature |
| 5.1.2 | ATT prompt shown without tracking, or tracking without the prompt | No tracking, no ATT prompt, labels say so |
| 4.2 | "Minimum functionality" — an app that is a thin wrapper or a repackaged list | The app is a genuine multi-feature client; the screenshots and demo data must show it |
| 2.3.3 | Screenshots that do not match the app | Captured from the submitted build |
| 5.1.1 | Requiring an account for features that do not need one | The public invite page requires no account; that is Phase 6, so v1 legitimately requires an account for everything it offers |
| 1.5 | A support URL that 404s | P5-25 ships both pages before submission |
| 2.3.10 | Mentioning another platform in the description or screenshots | Do not reference Android or the web app in the App Store listing |

**Edge cases.** Expo apps are occasionally flagged under 4.7 (third-party software) when
OTA updates are used to change app behaviour. Expo Updates in v1 delivers only JavaScript
that matches the reviewed build's functionality; do not use it to gate or add features. Say
so in the review notes if OTA updates are enabled.

---

### P5-32 — TestFlight

**Approach.**

1. `eas build --platform ios --profile production` then `eas submit --platform ios`. The
   build appears in App Store Connect within ~15 minutes of the upload completing.
2. **Export compliance**: answered by `ITSAppUsesNonExemptEncryption: false` in the config
   (P5-09). Without it, every build blocks on a manual question.
3. **Internal testing** first: up to 100 App Store Connect users, available immediately with
   no review. Install on your own devices and run the full E2E checklist manually.
4. **External testing**: up to 10,000 testers by public link or email. Requires a
   **Beta App Review**, which is lighter than a full App Review but does check the account
   deletion path and the permission strings. Budget a day.
5. Provide **beta app description** and **what to test** notes with each build. Testers who
   do not know what changed do not test it.
6. Builds expire after **90 days**. Plan a cadence.

**Edge cases.** A TestFlight build pointing at the dev API is the classic mistake. The
production EAS profile sets `EXPO_PUBLIC_PROFILE=prod`; assert it in a smoke check on the
built app before distributing — the Settings screen should show the API host it is talking
to in a debug row.

---

### P5-33 — Performance pass

**Approach.** Measure, record the numbers in the PR, and only then decide what to change.
The targets are in [`../01-product/overview.md`](../01-product/overview.md) §7 and
[`../02-architecture/tech-stack.md#45-cold-start-budget`](../02-architecture/tech-stack.md#45-cold-start-budget).

| Target | Measurement | Gate |
| --- | --- | --- |
| S1: explicit destination choice to saved under 5 s | Maestro flow for **Task**, **Plan**, and **List item**, timed from the first destination tap; median of 10 runs on a physical iPhone 13 or newer | Yes |
| S2: Today loads in one API call | Playwright network-count assertion | Yes |
| S3: Today renders under 1.0 s cached, 2.0 s cold | Instrumented client timing, mount to first painted row | Yes |
| Cold start init under 400 ms p95 | The CI cold-start job: force execution-environment recycling by updating an environment variable, invoke three times, read `initDuration` | Yes |
| Cold `GET /v1/agenda` under 700 ms total | Same job | Yes |
| Warm server-side p95 under 60 ms | CloudWatch `Duration` p95 over the smoke run | Report only |
| Lambda bundle under 5 MB zipped | `scripts/check-bundle-size.mjs` | Yes, already gating since Phase 0 |

Run AWS Lambda Power Tuning against the agenda endpoint with a **synthetic** seeded dataset
and set the memory from that curve, rather than shipping 1024 MB as an unmeasured guess.
Record the curve in the PR.

> **Decision:** this phase picks an initial memory setting; it does **not** close **OQ-3**.
> `phase-09-followup-and-launch.md` P9-15 owns the closure, because a power-tuning curve is
> only meaningful against real traffic shapes and at TestFlight scale there are too few
> users to produce any. Measuring twice is deliberate: once cheaply so the first beta build
> does not have terrible cold starts, once properly when there is something to measure.

**Edge cases.** Measure on a physical device, not the simulator — the simulator's JS
performance flatters the app by a wide margin. Measure over a real cellular connection for
S1 and S3, not office wifi.

---

### P5-34 — Accessibility pass

**Approach.** A systematic pass against
[`../01-product/interaction-contract.md`](../01-product/interaction-contract.md) §6, with a
recorded result per row rather than a general "we checked it".

| Check | Method |
| --- | --- |
| Every interactive element ≥ 44 × 44 pt | Automated layout test over every rendered primitive in the E2E flows |
| ≥ 8 pt between adjacent targets | Same |
| Every row's accessibility elements, in order, with the labels in §6.2 | VoiceOver walkthrough of Today, a list, and a plan detail, recorded as a screen capture |
| Every swipe action available as a rotor action | VoiceOver rotor check on each row type |
| Dynamic type at the largest non-accessibility size **and** at AX5 | Screenshots at both, on Today, a form, and a plan detail; assert no clipping and the horizontal-to-vertical reflow above `xxxLarge` |
| Contrast ≥ 4.5:1 body / ≥ 3:1 controls, light and dark | Automated token-pair test (from the Phase 1 `packages/ui` primitives) plus a manual check of any composed colour |
| Colour is never the only carrier of meaning | Manual review of completion, pending RSVP, overdue and balance direction |
| Reduce Motion honoured | Toggle the setting, verify cross-fades and no row animations |
| Web: focus order equals visual order, no positive `tabIndex`, visible focus ring, skip link | Playwright keyboard walk plus an axe-core scan on every route |
| Web: landmarks and live regions | axe-core |

**Edge cases.** The layout must be verified at **320 pt width** with no horizontal scrolling
and no clipped controls. Titles wrap to two lines before truncating and never truncate at
one line at the default type size.

**Tests.** axe-core in the Playwright suite, failing on any serious or critical violation.
The VoiceOver walkthrough is manual and its recording is the artefact.

---

### P5-35 / P5-36 — Prod alarms and a rehearsed rollback

**Approach.** Bring the two deferred alarms live: `ses-bounce-rate` (> 5% over 15 minutes)
and `reminder-errors` (≥ 3 in 15 minutes). A silent reminder failure is invisible to users
and therefore invisible to you.

Write `docs/05-operations/runbook.md` covering the three incident actions from
[`../02-architecture/security-privacy.md`](../02-architecture/security-privacy.md) §9:
revoking one user's tokens, rotating a secret, and taking the API offline (throttle to zero,
reserved concurrency to zero, or roll back).

Then **rehearse a rollback on prod**, deliberately, while nobody depends on it:

1. Deploy a trivially bad change (a health endpoint returning the wrong SHA).
2. Detect it with the smoke test.
3. Roll back with `aws lambda update-alias --function-name od-api-prod --name live
   --function-version <previous>`, and time it.
4. Follow within the hour with a revert commit and a real deploy, so CDK and reality agree
   again.

A rollback path nobody has ever executed is a rollback path that does not work.

**Tests.** The rehearsal is the test. Record the elapsed time in the runbook.

## Acceptance criteria

1. `ordinarydays.app` resolves through Route 53, both ACM certificates report `ISSUED`, and
   `https://api.ordinarydays.app/v1/health` returns `200` with the deployed SHA.
2. No file under `apps/`, `packages/` or `services/` contains an `execute-api` hostname, and
   the shipped clients reach the API only at `api.ordinarydays.app` or
   `api.dev.ordinarydays.app`.
3. A sign-up on prod delivers a verification email from `no-reply@ordinarydays.app` whose
   headers show `dkim=pass`, `spf=pass` and `dmarc=pass`.
4. After signing in on `https://ordinarydays.app`, the refresh cookie carries `HttpOnly`,
   `Secure`, `SameSite=Lax` and `Domain=.ordinarydays.app`, and a refresh without
   `X-CSRF-Token` returns `403`.
5. The first prod deploy blocked on the `production` GitHub environment approval and the
   five-minute wait timer, both observed, and prod smoke tests passed afterwards.
6. `https://ordinarydays.app` serves the production web build over CloudFront with a valid
   certificate, HSTS, and an **enforcing** CSP, and a full Playwright run produces zero CSP
   violations.
7. A direct `GET` against the prod web S3 bucket URL returns `403`.
8. A production EAS build installs from TestFlight on a physical device and its debug row
   shows `api.ordinarydays.app`, not the dev host.
9. Setting a reminder two minutes out, backgrounding the app, and waiting delivers a push
   whose title is the activity's title verbatim and whose tap opens that activity's screen.
10. A reminder on a daily 18:00 task fires at 18:00 local on both sides of a DST transition,
    verified by scheduling across the boundary with a shifted device clock.
11. A recurring series never has more than two pending EventBridge schedules **per user**,
    verified by listing schedules for a daily series after three fires.
12. Completing or skipping an occurrence before its reminder fires cancels that schedule, for
    every user who had one.
13. A notification held by quiet hours arrives at 07:00 local in the **recipient's** timezone;
    a reminder for a 06:30 activity arrives at 06:30; four held items arrive as one
    `held_digest`.
14. A plan change made at 23:00 for an activity starting at 09:00 the next day is delivered
    immediately; the identical change for an activity starting at 13:00 the next day is held
    to the digest; a cancellation and a date change at the same offset behave identically.
15. On a shared plan where two participants hold reminders at different offsets, two pushes
    are sent at two times to two devices, **neither participant receives the other's**, and a
    participant with no registered device suppresses nobody else's.
16. A clean install reaches Today with **no** system notification dialog; the pre-prompt
    appears the first time a reminder is set; `Not now` does not re-appear for 14 days.
17. There is no numeric badge anywhere in the app — on the app icon, the tab bar, the
    Profile entry point, or any row.
18. `Settings → Account → Delete account` requires re-authentication, and after confirming:
    the previous token `401`s, no push arrives, and no schedule fires for that user.
19. Signing in within 30 days restores the account completely, including activities, lists
    and settings.
20. A purge run on a `purgeAfter`-elapsed profile deletes every item in that user's
    partitions and their S3 objects, and leaves their participant row on another user's
    activity present with the display name and without the email. It leaves no orphan owned
    List partition; after shared Lists land, it also removes the user's memberships and
    reciprocal `LLINK#` rows from other-owned Lists, preserves those Lists' items and People
    records, and decrements each `memberCount` exactly once.
21. `GET /v1/me/export` (or the equivalent) keeps the export object available for 24 hours
    and returns a fresh short-lived presigned link on each request, to a JSON file
    containing the user's activities, lists and settings.
22. Setting `/od/prod/client/min-version` above the shipped version makes the app show the
    blocking upgrade screen within five minutes, with no deploy; a request with no
    `X-Client-Version` header is not blocked.
23. App Store Connect shows the app record complete: bundle ID `app.ordinarydays.ios`,
    privacy policy and support URLs both returning 200, privacy labels matching the table in
    P5-29, screenshots at 1320 × 2868, and review notes naming the account-deletion path.
24. The demo account signs in on the production build with no email verification step and
    lands on a populated Today.
25. Beta App Review is passed and at least three external testers who are not the founder
    have installed the build and completed the create-a-task flow.
26. Measured and recorded: S1 median under 5 s on a physical device over cellular; S3 under
    1.0 s cached and 2.0 s cold; Lambda init p95 under 400 ms; cold `GET /v1/agenda` under
    700 ms; zipped bundle under 5 MB.
27. Accessibility: axe-core reports zero serious or critical violations on every web route;
    the VoiceOver walkthrough of Today, a list and a plan detail is recorded and matches
    §6.2's labels; layouts hold at AX5 and at 320 pt width.
28. A rollback of the prod API alias has been executed deliberately, timed, and recorded in
    the runbook, and CDK and reality were brought back into agreement afterwards.
29. Prod DynamoDB has PITR and deletion protection on, and an on-demand backup has been
    taken and its restore verified into a scratch table at least once.
30. An image uploaded through the Phase 3 presign path renders through
    `media.dev.ordinarydays.app` on dev and `media.ordinarydays.app` on prod, and a direct
    `GET` against the media bucket's S3 URL returns `403` on both.

## Out of scope for this phase

| Do not build | Owned by |
| --- | --- |
| The Cognito pool, app clients, triggers, `CognitoIdentityProvider`, `/public/v1/auth/*`, and every auth screen | Phase 4 — already built. This phase changes their configuration, not their design. |
| `cdk bootstrap`, the GitHub OIDC provider, the deploy roles, `AccountStack` | Phase 4 |
| A custom Cognito auth domain — the default hosted-UI domain stays | Not planned |
| TOTP MFA enrolment UI — the pool is `OPTIONAL`, the settings screen is not built | Phase 9 |
| Sharing, participants, invitations, the public invite page, guest RSVP | Phase 6 |
| SES production access — dev and prod both stay in the sandbox until there are guests to email | Phase 6 |
| Guest → account linking in the post-confirmation trigger | Phase 6 |
| iOS share-sheet ingestion | Phase 9 (P9-11) |
| Expenses, balances, settlement, the People layer | Phase 7 |
| DynamoDB Streams, the balance recalculation fan-out | Phase 7 |
| The 60-day GSI archival sweep (the deletion purge job is Phase 5; the archival sweep is not) | Phase 9 (P9-33) |
| Web push, service worker, VAPID | Not in v1 |
| Any AI capture implementation | Phase 8 |
| A public App Store release — this phase ends at TestFlight external testing | Phase 9 |
| An analytics or attribution SDK — adding one changes the privacy labels | Not in v1 |
| iPad-specific layout and iPad App Store assets | Post-beta |
| In-app purchases, subscriptions, paywalls | Phase 8 at the earliest (open question OQ-6) |
| AWS WAF | Only if the public surface is actually abused |

## Risks and gotchas

| Risk | Signal | Mitigation |
| --- | --- | --- |
| **The auth cutover ships partially** | Sign-in works on one platform or one environment and fails on the other, with a redirect-mismatch error that names nothing | P5-04 changes callback URLs, the Apple Services ID, the cookie attributes and CORS together, and its tests cover web, iOS and both environments before the task closes. |
| The `execute-api` endpoint keeps working after the custom domain exists | A client left pointing at it goes on working, and the mistake surfaces only much later | A CI grep asserting no `execute-api` hostname in `apps/`, `packages/` or `services/`. |
| SES is in the sandbox and the demo account's address is unverified | The App Review demo account cannot receive a verification code and the submission fails on 2.1 | Every test and demo address is verified as an SES identity in P5-03, and P5-31 asserts the demo account signs in on prod. |
| **Apple Developer enrolment is not complete** when the phase starts | P5-09 blocks and every App Store task downstream of it stalls | Enrolment starts on day one of Phase 4 (P4-01), not here. Organisation enrolment with a D-U-N-S number can take weeks. |
| **Rejection for missing in-app account deletion** | The first submission comes back | P5-21/P5-23 are built early in the phase, and the review notes name the exact path. This is the single most common rejection for an app with accounts. |
| **Rejection under 4.8** because Sign in with Apple is broken in the production build only | Apple sign-in works on dev and fails on prod | The prod bundle identifier must match the App ID registered for Sign in with Apple exactly (P5-09), and both Cognito hosted-UI domains must be on the Apple Services ID. Test Apple sign-in on the TestFlight build, not only on dev. |
| An enforcing CSP blocks the app's own bundle | A blank page on prod with no server error and therefore no alarm | Report-only for a week first; read the reports; then enforce. Playwright asserts zero violations. |
| A TestFlight build points at the dev API | Beta testers write to dev; their data is lost when dev is wiped | The debug row showing the API host, asserted in the pre-distribution checklist. |
| EAS free-plan queue delays the build | The submission slips by a day | Never make a deploy depend on a build; schedule the first production build for a day when waiting is fine. |
| Expo push receipts are never checked | Pushes silently stop for users who reinstalled, and the token eventually throttles | The reminder Lambda reads receipts and deletes `DeviceNotRegistered` device rows. |
| Reminder scheduling and agenda expansion disagree at a DST boundary | A reminder fires an hour early twice a year | Both derive from `toUtcInstant` in `packages/shared/src/recurrence/calendar.ts`; a test asserts agreement at the boundary. |
| Unbounded EventBridge schedules for long-running series | The account schedule quota is approached and creates start failing | Only the next two occurrences are ever scheduled, **per user**; acceptance criterion 11 asserts it. The per-user fan-out multiplies the count by the participant cap, so the two bounds — 50 participants and 3 reminders each — are what keep it finite. |
| **The reminder Lambda reads one array off `META`** and sends one push per activity, because that is the shape the field used to have | Every participant receives the plan creator's reminder at the creator's offset, or only the creator is reminded at all | `Activity` has no `reminders[]` (ADR-047). The Lambda groups `REM#` rows by `userId` and fans out; criterion 15 asserts that neither participant receives the other's, on the recipient list of the push call rather than by inspection. |
| **Quiet hours are evaluated against the sender's or the owner's profile** rather than the recipient's | Two participants in two timezones get the same delivery decision, and it is wrong for one of them | The rule is stated in P5-15 and the boundary cases in criterion 13 name the recipient's timezone explicitly. |
| The 12-hour plan-change exception is re-narrowed to cancellations, or re-expressed as "today or tomorrow" | A plan moved at 23:50 to 09:00 the next morning is held until 07:00, arriving 100 minutes before it starts | One clock threshold on `scheduledAtUtc`, not a calendar comparison and not a per-field rule. Criterion 14 asserts a cancellation and a date change at the same offset behave identically, so the two cannot drift apart again. |
| Privacy labels under-declare | Rejection, and a second review cycle | The P5-29 table is derived from a grep of the actual dependency list, not from memory. |
| Screenshots show a feature not in the build | Rejection under 2.3.3 | Captured from the submitted build with seeded data. |
| The rollback path has never been executed | It does not work when it is needed | P5-36 rehearses it deliberately on prod and records the time. |
| The kill switch is used for feature gating | Users learn to expect forced updates and the mechanism stops meaning anything | Documented as broken-builds-only in the runbook. |
