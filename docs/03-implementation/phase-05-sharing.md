# Phase 5 — Sharing and invites

## Goal

At the end of this phase a plan stops being a private note and becomes a thing two or more
people can coordinate around. An owner can add people to any activity from one picker;
app users receive an in-app invitation, a push, and the plan on their own Today with a
pending RSVP; everyone else receives a link to a public page that works with no account, no
install, and no interstitial, and that lets them answer Going / Maybe / Can't go and put the
plan into Google Calendar or Apple Calendar in three taps. Every change to a shared plan
writes to that plan's updates feed and notifies the people who need to know. Amazon SES is
out of the sandbox on a domain that passes DKIM, SPF and DMARC, so guest invitations
actually arrive. A guest who later signs up with the same verified email finds their plans
already in the app rather than a second copy of them.

## Prerequisites

| # | Requirement | Source |
| --- | --- | --- |
| 1 | Phases 0–4 complete; v1 private beta is on TestFlight | Phase 4 |
| 2 | `Activity`, `ActivityIndex`, `Person`, `Participant`, `Invite` types exist in `packages/shared/src/types/` | [`../02-architecture/data-model.md`](../02-architecture/data-model.md) §4 |
| 3 | `assertActivityAccess(userId, activityId, level)` exists in `services/api/src/services/authz.ts` | [`../02-architecture/tech-stack.md`](../02-architecture/tech-stack.md) §4.2 |
| 4 | Push registration (`POST /v1/me/devices`), the notification inbox, and the reminder Lambda ship and work | [`../01-product/notifications.md`](../01-product/notifications.md) |
| 5 | The web build exports statically and CloudFront serves it with the SPA fallback | [`../02-architecture/infrastructure.md`](../02-architecture/infrastructure.md) §4.1 |
| 6 | `ordinarydays.app` is registered, the hosted zone exists, and both ACM certificates validate | Phase 0 |
| 7 | The rate-limit middleware and its `RATE#` counter item work for authenticated routes | [`../02-architecture/security-privacy.md`](../02-architecture/security-privacy.md) §5 |
| 8 | `docs/generated/openapi.json` is generated and CI fails on staleness | [`../02-architecture/api-contract.md`](../02-architecture/api-contract.md) §6 |

Two canonical-document amendments this phase depends on are already recorded in
[`../02-architecture/data-model.md`](../02-architecture/data-model.md):

- `GUESTEMAIL#<lowercased-email>` / `OWNER#<ownerId>#PERSON#<personId>` in §3.4, with
  access pattern 14b (OQ-9 in
  [`../02-architecture/decisions.md`](../02-architecture/decisions.md)). Without it, guest
  → account linking needs a `Scan`, which is banned.
- `Activity.icsSequence: number` in §4.1 (task P5-08). It is additive and needs no
  backfill; the repository defaults it to `0` on read.

## Deliverables

- [ ] A participant picker sheet that adds an existing contact, a typed guest, or a guest by
      email, enforces the 50-participant cap inline, and works on both platforms.
- [ ] `POST`/`PATCH`/`DELETE /v1/activities/:id/participants*` implemented with the
      transaction budget in §Tasks P5-11 respected.
- [ ] App users receive `invitation_received` push + inbox entry, and the plan appears on
      their Today with an inline `Going · Maybe · Decline` control.
- [ ] `POST`/`DELETE /v1/activities/:id/invites` for shareable links.
- [ ] `https://ordinarydays.app/invite/<token>` renders the allow-listed public projection
      and nothing else, with no account prompt above the fold.
- [ ] `POST /public/v1/invites/:token/rsvp` records a guest RSVP, rate-limited per IP and
      per token.
- [ ] `.ics` export from the public and the authenticated surfaces, correct per RFC 5545,
      with stable `UID`s and incrementing `SEQUENCE`.
- [ ] A Google Calendar `302` from an allow-listed template URL.
- [ ] SES: domain identity with Easy DKIM, custom MAIL FROM for SPF alignment, a DMARC
      record, a configuration set with bounce/complaint alarms, and **production access
      granted**.
- [ ] Guest invitation, plan-changed and plan-cancelled emails, and nothing else.
- [ ] The plan updates feed with system entries for RSVP, schedule, rename, cancel, and
      participant changes.
- [ ] `plan_changed`, `plan_renamed`, `plan_cancelled`, `rsvp_changed`, `rsvp_guest`,
      `plan_update_posted`, `participant_left`, `invitation_reminder` delivered per
      [`../01-product/notifications.md`](../01-product/notifications.md) §7.
- [ ] Guest → registered-user linking on sign-up with a verified email, driven by a
      `GUESTEMAIL#` lookup partition.
- [ ] Success criterion S4 (guest RSVP in under 30 s, three taps) and S8 (the public
      projection leaks nothing) verified in CI.

## Tasks

| ID | Title | Area | Depends on | Parallel-safe | Size |
| --- | --- | --- | --- | --- | --- |
| P5-01 | SES domain identity, DKIM, MAIL FROM, SPF, DMARC in CDK | infra | — | yes | M |
| P5-02 | SES production-access request and quota | infra | P5-01 | yes | S |
| P5-03 | SES configuration set, event destination, bounce and complaint alarms | infra | P5-01 | yes | S |
| P5-04 | Email sending service and the three templates | api | P5-01, P5-03 | no | M |
| P5-05 | Public route surface: routing, caching, CORS, CloudFront behaviour | infra/api | — | yes | M |
| P5-06 | Public rate limiting: per IP and per token | api | P5-05 | no | M |
| P5-07 | Invite token generation and encoding | shared | — | yes | S |
| P5-08 | `.ics` builder | shared | — | yes | L |
| P5-09 | Google Calendar template URL builder | shared | — | yes | S |
| P5-10 | Schemas for participants, invites, updates and the public projection | shared | — | yes | M |
| P5-11 | Participant repository and the transaction budget | api | P5-10 | no | L |
| P5-12 | `POST /v1/activities/:id/participants` | api | P5-11, P5-07 | no | L |
| P5-13 | `PATCH /v1/activities/:id/participants/:personId` — RSVP | api | P5-11 | no | M |
| P5-14 | `DELETE /v1/activities/:id/participants/:personId` — remove and leave | api | P5-11 | no | M |
| P5-15 | Shareable invites: `POST`/`DELETE /v1/activities/:id/invites` | api | P5-07, P5-11 | no | M |
| P5-16 | The public invite projection and `GET /public/v1/invites/:token` | api | P5-10, P5-05 | no | L |
| P5-17 | `POST /public/v1/invites/:token/rsvp` | api | P5-16, P5-06 | no | M |
| P5-18 | `.ics` endpoints, public and authenticated | api | P5-08, P5-16 | no | M |
| P5-19 | Google Calendar redirect endpoint | api | P5-09, P5-16 | no | S |
| P5-20 | Updates feed: read, write, and server-side system entries | api | P5-10 | no | M |
| P5-21 | Change detection and plan-change notifications | api | P5-20, P5-04 | no | L |
| P5-22 | Invitation and RSVP notifications, inbox entries, invitation reminder | api | P5-12, P5-13 | no | M |
| P5-23 | Invite lifetime: expiry, revocation, TTL, rotation | api | P5-15 | no | M |
| P5-24 | Participant-aware fan-out: reschedule and the delete cascade job | api | P5-11 | no | L |
| P5-25 | Guest → account linking and the `GUESTEMAIL#` partition | api | P5-12 | no | L |
| P5-26 | Authorisation matrix enforcement and its test walk | api | P5-12, P5-13 | no | M |
| P5-27 | Minimal People read surface for the picker | api | P5-11 | no | M |
| P5-28 | The participant picker sheet | mobile | P5-27, P5-12 | no | L |
| P5-29 | Plan detail: PEOPLE section, share sheet, invite-link affordances | mobile | P5-12, P5-15 | no | M |
| P5-30 | RSVP affordances on agenda rows and in the inbox | mobile | P5-13, P5-22 | no | M |
| P5-31 | Updates feed UI | mobile | P5-20 | yes | M |
| P5-32 | Add-to-calendar affordance on plan detail | mobile | P5-18, P5-19 | yes | S |
| P5-33 | The public invite page | web | P5-16, P5-17, P5-18 | no | L |
| P5-34 | E2E and projection-leak tests, S4 and S8 | ci | P5-33 | no | M |

---

### P5-01 — SES domain identity, DKIM, MAIL FROM, SPF, DMARC in CDK

**What to build.** Everything needed for `no-reply@ordinarydays.app` to reach an inbox
rather than a spam folder, defined in CDK so the DNS records cannot drift from the identity
that depends on them.

**Files.**

- `infra/lib/stacks/email-stack.ts` — new stack `od-email-{env}`.
- `infra/bin/ordinarydays.ts` — instantiate it after `DnsStack`, before `ApiStack`.
- `infra/lib/config.ts` — add `sesMailFromDomain`, `dmarcReportAddress`.
- `infra/test/email-stack.test.ts`.

> **Decision:** SES gets its own stack rather than joining `DnsStack`. The identity, its
> DKIM CNAMEs, the MAIL FROM MX and SPF records, DMARC, and the configuration set are one
> coherent unit that is deployed once and then rarely touched, and putting them in
> `DnsStack` would mean a certificate change and an email change share a blast radius.

**Approach.**

```ts
const identity = new ses.EmailIdentity(this, 'Domain', {
  identity: ses.Identity.publicHostedZone(zone),          // creates the three DKIM CNAMEs
  dkimSigning: true,
  dkimIdentity: ses.DkimIdentity.easyDkim(ses.EasyDkimSigningKeyLength.RSA_2048_BIT),
  mailFromDomain: cfg.sesMailFromDomain,                  // mail.ordinarydays.app
  mailFromBehaviorOnMxFailure: cfg.stage === 'prod'
    ? ses.MailFromBehaviorOnMxFailure.REJECT_MESSAGE
    : ses.MailFromBehaviorOnMxFailure.USE_DEFAULT_VALUE,
});
```

DNS records, all in the same stack:

| Name | Type | Value | Purpose |
| --- | --- | --- | --- |
| `<t1>._domainkey`, `<t2>._domainkey`, `<t3>._domainkey` | CNAME | `<tN>.dkim.amazonses.com` | Easy DKIM, created by `EmailIdentity` |
| `mail.ordinarydays.app` | MX | `10 feedback-smtp.us-east-1.amazonses.com` | Custom MAIL FROM, created by `EmailIdentity` |
| `mail.ordinarydays.app` | TXT | `v=spf1 include:amazonses.com -all` | SPF for the MAIL FROM domain, so SPF **aligns** with the From domain |
| `ordinarydays.app` | TXT | `v=spf1 -all` | The apex sends no mail directly. Explicit, not absent. |
| `_dmarc.ordinarydays.app` | TXT | `v=DMARC1; p=none; rua=mailto:<dmarcReportAddress>; fo=1; adkim=r; aspf=r; pct=100` | DMARC, starting permissive |

> **Decision:** `mailFromBehaviorOnMxFailure` is `REJECT_MESSAGE` in prod. The alternative
> silently falls back to `amazonses.com` as the MAIL FROM, which breaks SPF alignment and
> therefore weakens DMARC without any signal that it happened. Because the MX record is
> created by the same CDK construct as the identity, the failure mode this protects against
> is a manual DNS edit, and it should be loud.

> **Decision:** DMARC ships at `p=none` and is tightened to `p=quarantine` after 14
> consecutive days of aggregate reports showing 100% DKIM pass, then to `p=reject` after a
> further 14. The tightening is two one-line CDK changes, each its own pull request with the
> report evidence in the description. Do not start at `p=reject`: Cognito's own mail
> (verification, password reset) is routed through this identity, and locking a
> misconfiguration out of the inbox locks users out of the product.

**Edge cases.**

- DKIM CNAMEs take up to 72 hours to be seen by SES. Deploy this task first in the phase and
  check `aws sesv2 get-email-identity --email-identity ordinarydays.app` until
  `DkimAttributes.Status` is `SUCCESS` before requesting production access.
- Dev uses `dev.ordinarydays.app` as a **separate** identity with its own DKIM records so
  dev sending cannot affect the prod domain's reputation.
- The `dmarc@` mailbox must exist and be forwarded somewhere the founder reads. An `rua`
  pointing at a black hole makes the DMARC record decorative.

**Tests.** CDK assertions: exactly one `AWS::SES::EmailIdentity` per stage with
`DkimSigningAttributes.NextSigningKeyLength = RSA_2048_BIT`; a `_dmarc` TXT record exists
and its value starts with `v=DMARC1`; the MAIL FROM domain is a subdomain of the config's
domain; `MailFromAttributes.BehaviorOnMxFailure` is `REJECT_MESSAGE` when `stage === 'prod'`.

---

### P5-02 — SES production-access request and quota

**What to build.** The request itself, plus the evidence AWS asks for, recorded in the repo
so it can be re-submitted if it is rejected.

**Files.** `docs/05-operations/ses-production-access.md` — the submitted text, the date, the
case ID, and the outcome.

**Approach.** Production access is requested per account and per region. It is granted by AWS
Support after a human review. Submit it via the API so the exact text is in git:

```bash
aws sesv2 put-account-details \
  --production-access-enabled \
  --mail-type TRANSACTIONAL \
  --website-url https://ordinarydays.app \
  --contact-language EN \
  --additional-contact-email-addresses alerts@ordinarydays.app \
  --use-case-description "$(cat docs/05-operations/ses-use-case.txt)"
```

What AWS asks for, and the answer to give in `ses-use-case.txt`:

| AWS asks | Answer |
| --- | --- |
| What type of mail | Transactional only. No marketing, no newsletters, no digests. |
| Your website | `https://ordinarydays.app`, with the privacy policy at `/privacy`. |
| How recipients are obtained | A recipient's address is typed into the app by a user who is inviting that person to a specific plan they created. Addresses are never purchased, scraped, imported from a device address book, or shared between users. |
| What you send | Three messages: an invitation to one plan, a notice that the plan's date/time/location changed, and a notice that it was cancelled. Nothing else. |
| Expected volume | Under 100/day at launch; the participant cap is 50 per plan and the API rate limit bounds the rest. |
| How bounces and complaints are handled | The account-level suppression list is on. A configuration set publishes bounce, complaint, delivery and reject events to CloudWatch; alarms fire to the operator at a 5% bounce rate and a 0.1% complaint rate. A hard bounce marks the `Person.email` invalid and the app stops sending to it and tells the owner the address did not work. |
| How recipients unsubscribe | Every guest email carries a one-click link that revokes that guest's invite token, which stops every future send about that plan. There is no list to unsubscribe from because there is no list. |

**Edge cases.**

- The default production sending quota (50,000 messages/day, 14 per second) is far beyond
  what this app needs; do not request an increase, it invites more scrutiny.
- If the request is rejected, the rejection names a missing element. Fix it in
  `ses-use-case.txt` and resubmit; do not open a second case.
- **Budget several days.** Nothing downstream in this phase can be verified end to end
  against a real recipient until this lands. Order the phase so P5-01/02/03 start on day one
  and the rest proceeds against the dev sandbox with a verified recipient.

**Tests.** A smoke script `scripts/ses-check.mjs` asserts
`GetAccountResponse.ProductionAccessEnabled === true` for prod and prints the identity's DKIM
and MAIL FROM status. It runs in the prod deploy workflow and fails the deploy if production
access has been revoked.

---

### P5-03 — SES configuration set, event destination, bounce and complaint alarms

**What to build.** The observability that keeps the domain's reputation from degrading
silently.

**Files.** `infra/lib/stacks/email-stack.ts`,
`infra/lib/stacks/observability-stack.ts`.

**Approach.** A configuration set `od-{env}` with reputation metrics enabled and a CloudWatch
event destination for `SEND`, `DELIVERY`, `BOUNCE`, `COMPLAINT`, `REJECT`,
`RENDERING_FAILURE`. Every `SendEmail` call names the configuration set; the IAM condition in
[`../02-architecture/security-privacy.md`](../02-architecture/security-privacy.md) §2.2
already scopes the role to it.

Alarms, on the `AWS/SES` namespace, wired to `od-alerts-{env}`:

| Alarm | Condition | Why that number |
| --- | --- | --- |
| `od-{env}-ses-bounce-rate` | `Reputation.BounceRate` > 0.05 for 1 datapoint | AWS places an account under review above 5% and may pause sending above 10% |
| `od-{env}-ses-complaint-rate` | `Reputation.ComplaintRate` > 0.001 for 1 datapoint | AWS reviews above 0.1%; the app should never get near it |
| `od-{env}-ses-send-spike` | `Send` > 500 in 1 hour | Nothing legitimate at this scale sends 500 emails in an hour |

**Edge cases.** Reputation metrics are published at a low frequency; treat a missing
datapoint as `notBreaching`, not `breaching`, or the alarm sits in `INSUFFICIENT_DATA` and is
ignored. Bounce and complaint rate are account-wide, so a dev misconfiguration damages prod —
which is the one real cost of the single-account decision (ADR-010) and the reason dev sends
only to a verified address.

**Tests.** CDK assertions that the three alarms exist with an SNS action, and that the
configuration set has `ReputationOptions.ReputationMetricsEnabled = true`.

---

### P5-04 — Email sending service and the three templates

**What to build.** One service with exactly three send functions, and no fourth.

**Files.**

- `services/api/src/services/email.ts`
- `services/api/src/email/templates/invitation.ts`, `plan-changed.ts`, `plan-cancelled.ts`
- `services/api/src/email/render.ts` — the plain-text + minimal-HTML renderer
- `services/api/src/email/__tests__/`

**Approach.** `SESv2Client` is created lazily inside the service, not at module scope, so a
request path that never sends mail does not pay for the client's construction
([`../02-architecture/tech-stack.md`](../02-architecture/tech-stack.md) §4.5). Each send:

1. Checks the guest's token is not revoked or expired. A revoked token means the guest
   opted out; the send is skipped and logged at `info`.
2. Renders both a `text/plain` and a `text/html` part. The HTML part is a single-column table
   layout with inline styles, no images, no tracking pixel, no web fonts, no external CSS.
3. Sends with `ConfigurationSetName: od-{env}` and `FromEmailAddress: no-reply@<domain>`,
   `ReplyToAddresses: []`.
4. Logs `{ requestId, activityId, personId, template, messageId, emailHash }` — the address is
   SHA-256 hashed, never logged in plaintext
   ([`../02-architecture/security-privacy.md`](../02-architecture/security-privacy.md) §1
   row 8).

Every template ends with the same two lines:

```
You're getting this because <Owner display name> invited you to this plan.
Stop getting emails about this plan: https://ordinarydays.app/invite/<token>/stop
```

`GET /public/v1/invites/:token/stop` revokes the token, returns a plain confirmation page,
and is rate-limited like the rest of the public surface. It is the entire unsubscribe
mechanism, which is correct because there is no list.

**Edge cases.**

- A send failure never fails the originating request. Email is fire-and-forget from the
  handler's point of view: the participant is added, then the send is attempted, and a
  failure logs at `warn` and surfaces on the owner's participant row as
  `Invite not sent · Resend`.
- Dev is in the SES sandbox. `config.sesSandbox` is `true` in dev; a send to an unverified
  address logs at `warn` with the template name and returns success, so dev flows are not
  blocked by an unverifiable recipient.
- A `MessageRejected` for a suppressed address marks `person.emailBounced = true` and the
  owner's participant row reads `That address didn't work.`
- Guest emails are only ever sent for invitation, plan change and plan cancellation
  ([`../01-product/notifications.md`](../01-product/notifications.md) §6.3). A pull request
  that adds a fourth send function needs an explicit product decision, and the test in
  §Acceptance criteria 21 fails without one.

**Tests.** `aws-sdk-client-mock` on `SESv2Client`: asserts the configuration set, the from
address, the presence of both MIME parts, the opt-out line, and that no other address ever
appears in `Destination`. A template snapshot test per template. A test that asserts exactly
three exported send functions.

---

### P5-05 — Public route surface: routing, caching, CORS, CloudFront behaviour

**What to build.** The boundary between `/public/v1/*` and everything else, hardened.

**Files.**

- `services/api/src/middleware/routeSplit.ts` (extend)
- `services/api/src/routes/public/invites.ts` (new)
- `services/api/src/app.ts`
- `infra/lib/stacks/web-stack.ts` — the CloudFront behaviour for `/invite/*`

**Approach.**

- `routeSplit` already skips auth for `/public/v1/*`. Extend it to also set
  `Cache-Control: no-store`, `Pragma: no-cache` and `X-Robots-Tag: noindex, nofollow` on
  every public response, and to reject any public path that is not in an explicit
  allow-list of four routes with `404`.
- CORS on the public prefix is `Access-Control-Allow-Origin: *` with **no** credentials. The
  public surface takes no cookie and no bearer token, so a wildcard origin is correct here
  and a credentialed one would be wrong.
- CloudFront: the web distribution serves `/invite/*` from the static export (it is a
  pre-rendered route). It must **not** proxy `/public/v1/*`; the page calls
  `api.ordinarydays.app` directly. This keeps invite revocation immediate with no cache
  window (privacy rule P5 in
  [`../01-product/sharing-and-people.md`](../01-product/sharing-and-people.md) §8).
- The invite HTML itself is cached by CloudFront for 60 seconds — it contains no plan data,
  only the shell that fetches it.

**Edge cases.** A `HEAD` on a public route must behave like `GET` minus the body, including
the rate-limit charge. `OPTIONS` is answered before rate limiting so a preflight cannot be
throttled into breaking the page.

**Tests.** Integration tests asserting: `Cache-Control: no-store` on all four public routes;
`404` for `/public/v1/anything-else`; no `Set-Cookie` on any public response; no
`Access-Control-Allow-Credentials` header on the public prefix. A CDK assertion that no
CloudFront behaviour has a path pattern beginning `/public`.

---

### P5-06 — Public rate limiting: per IP and per token

**What to build.** Two independent limiters on the only surface a stranger can reach.

**Files.** `services/api/src/middleware/rateLimit.ts`,
`services/api/src/lib/clientIp.ts`.

**Approach.** Reuse the `RATE#<hashedSubject>#<window>` item and the atomic
`ADD #n :one` with a conditional `#n < :limit`
([`../02-architecture/security-privacy.md`](../02-architecture/security-privacy.md) §5). Two
subjects apply to the public surface:

| Subject | Key | Limit | Window |
| --- | --- | --- | --- |
| Client IP | `RATE#ip:<sha256(ip + salt)>#<minute>` | 30 | 1 minute |
| Invite token, RSVP only | `RATE#tok:<sha256(token)>#<hour>` | 10 | 1 hour |

The IP comes from the **last** entry of `X-Forwarded-For` as set by API Gateway, never from a
client-supplied header or the first entry. The salt is an SSM parameter
`/od/{stage}/rate/ip-salt`, read at cold start, so a table dump does not permit reversing IPs
by rainbow table.

**Edge cases.**

- The token limiter is charged on the RSVP route only. Reading the invite page repeatedly is
  legitimate (a guest re-opening the link) and is covered by the IP limit alone.
- A `429` on the public surface returns `Retry-After` and the standard error envelope, with
  no information about whether the token exists.
- Shared NAT (an office, a conference) can plausibly produce 30 requests a minute from
  distinct real guests. The limit is per minute, not per hour, so the recovery is 60 seconds
  and the page's copy says so.
- The limiter must fail **open** on a DynamoDB error rather than blocking the whole public
  surface, and log at `error`. A rate limiter that takes the site down is worse than the
  abuse it prevents.

**Tests.** Integration tests with `aws-sdk-client-mock`: the 31st request in a minute from
one hashed IP returns `429` with `Retry-After`; the 11th RSVP for one token in an hour
returns `429`; two different tokens do not share a counter; a thrown DynamoDB error results
in `200`, not `500`.

---

### P5-07 — Invite token generation and encoding

**What to build.** The token, exactly as specified, in one place.

**Files.** `packages/shared/src/invite/token.ts`,
`packages/shared/src/invite/__tests__/token.test.ts`.

**Approach.**

```ts
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'; // 62
export const INVITE_TOKEN_LENGTH = 22;

export function generateInviteToken(randomBytes = crypto.randomBytes): string {
  const bytes = randomBytes(16);                 // 128 bits
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) { out = ALPHABET[Number(n % 62n)] + out; n /= 62n; }
  return out.padStart(INVITE_TOKEN_LENGTH, '0');  // fixed width, no length side channel
}
```

Entropy: `crypto.randomBytes(16)` is 128 bits. `ceil(128 / log2(62)) = 22`, so 22 base62
characters hold it exactly. The `padStart` matters: without it a token whose leading bytes
are zero is shorter, which leaks a bit and breaks the fixed-width validator.

Rules, enforced in review and by tests:

- Never `Math.random`, never `ulid`, never a hash of anything meaningful. A ULID would leak
  creation order ([`../02-architecture/data-model.md`](../02-architecture/data-model.md) §8).
- The validator is `/^[0-9A-Za-z]{22}$/` and runs before the `GetItem`, so a malformed token
  never becomes a DynamoDB key.
- Writes use `ConditionExpression: attribute_not_exists(pk)` and retry once on collision. At
  128 bits a collision will not happen; the condition costs nothing and documents the intent.

**Tests.** 100,000 generated tokens are all 22 characters, all match the validator, and all
distinct. A seeded fake `randomBytes` returning all-zero bytes produces `'0'.repeat(22)`.
The alphabet has 62 distinct characters. A statistical test asserts each alphabet position
appears in the first character within tolerance over 100,000 samples (catches a modulo-bias
regression).

---

### P5-08 — `.ics` builder

**What to build.** A typed iCalendar builder that produces one `VEVENT` correctly. This
closes OQ-12.

**Files.**

- `packages/shared/src/ics/build.ts` — `buildIcs(event: IcsEvent): string`
- `packages/shared/src/ics/escape.ts` — text escaping and 75-octet line folding
- `packages/shared/src/ics/__tests__/` — unit, golden files, and a parser-oracle test

> **Decision:** write the builder rather than adding a dependency. The output surface is one
> `VEVENT` with fewer than fifteen properties, the hard parts are escaping and folding
> (about sixty lines), and the risk of a runtime dependency in the money-free but
> correctness-critical export path is not worth avoiding that. `ical.js` is added as a
> **dev** dependency and used in tests as an independent parser oracle, which gives the
> confidence a library would have given without shipping one.

**Approach — the exact output.**

```
BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Ordinary Days//EN
CALSCALE:GREGORIAN
METHOD:PUBLISH
BEGIN:VEVENT
UID:<uid>
DTSTAMP:20260806T141522Z
DTSTART:20260816T160000Z
DTEND:20260816T220000Z
SUMMARY:Food Festival
DESCRIPTION:An all-day street food festival.\n\nFrom Ujjwal
LOCATION:Penn's Landing\, Philadelphia
URL:https://ordinarydays.app/invite/8FD92Kx1a2B3c4D5e6F7g8
STATUS:CONFIRMED
SEQUENCE:2
TRANSP:OPAQUE
END:VEVENT
END:VCALENDAR
```

Every rule that has to be right:

| Concern | Rule |
| --- | --- |
| Line endings | `CRLF`, always, including the final line. `LF` alone breaks Outlook. |
| Folding | Fold at **75 octets**, not 75 characters. Continuation lines begin with a single space. A multi-byte UTF-8 sequence is never split across a fold. |
| Escaping | In `SUMMARY`, `DESCRIPTION`, `LOCATION`: `\` → `\\`, `;` → `\;`, `,` → `\,`, newline → `\n`. Colon is **not** escaped. `URL` is a URI value and takes no text escaping. |
| Control characters | Stripped from all text values before escaping. |
| `DTSTAMP` | Now, in UTC, `YYYYMMDDTHHMMSSZ`. Required. |
| Timed events | `DTSTART`/`DTEND` in **UTC** from `schedule.scheduledAtUtc` / `endAtUtc`. |
| All-day events | `DTSTART;VALUE=DATE:20260816` and `DTEND;VALUE=DATE:20260817` — the end date is **exclusive**. |
| Missing end time | `DURATION:PT1H` for a timed event; the exclusive next day for an all-day one. A zero-length `VEVENT` renders as an unreadable sliver in both Google and Apple. |
| `RRULE` | Never emitted. A public invite is one occurrence ([`../01-product/sharing-and-people.md`](../01-product/sharing-and-people.md) §4.5); the authenticated export is one occurrence too. |
| `ATTENDEE` | Never emitted, on either surface. Exporting a plan must not leak the guest list, and some clients treat `ATTENDEE` as a licence to email a reply to an address nothing reads. |
| `ORGANIZER` | Never emitted. An `ORGANIZER` with no `ATTENDEE` is meaningless, and its presence makes some clients render the event as an invitation awaiting a reply. The organiser's display name goes in `DESCRIPTION` as a final `From <name>` line. |

> **Decision — no `VTIMEZONE`, ever.** Times are emitted as UTC instants derived from
> `schedule.scheduledAtUtc`, so no `TZID` parameter and no `VTIMEZONE` component are
> required. Generating a correct `VTIMEZONE` means emitting the IANA zone's DST transition
> rules as `RRULE`s, which is precisely the kind of thing that is subtly wrong for years
> before anyone notices, and it buys nothing: every calendar client renders a UTC instant in
> the viewer's local zone correctly. The one case where `VTIMEZONE` is genuinely required is
> a **recurring** event expressed in local time, and this product never exports one. If a
> future release exports a series, `VTIMEZONE` becomes mandatory in the same change, and that
> is written here so nobody exports an `RRULE` in UTC by mistake.

> **Decision — `METHOD:PUBLISH`, never `METHOD:REQUEST`.** `REQUEST` is the iTIP scheduling
> method: it means "you are invited, reply to the organiser", and it obliges a well-behaved
> client to emit a `REPLY` by email to the `ORGANIZER` address. This product has no mailbox
> that reads replies, emits no `ATTENDEE` lines for a `REQUEST` to address, and already has a
> reply channel — the RSVP buttons on the page the file came from. `PUBLISH` states the
> truth: here is an event, put it in your calendar. The same holds when a plan is cancelled:
> the file is re-served with `STATUS:CANCELLED` and a bumped `SEQUENCE`, still under
> `PUBLISH`, not `METHOD:CANCEL`.

**`UID` stability.**

| Surface | `UID` | Why |
| --- | --- | --- |
| `GET /public/v1/invites/:token/ics` | `<token>@ordinarydays.app` | The activity id is never exposed publicly ([`../01-product/sharing-and-people.md`](../01-product/sharing-and-people.md) §4.3). A guest who re-downloads after a reschedule gets an **update** to the same calendar entry, not a duplicate — which is the entire point. |
| `GET /v1/activities/:id/ics` | `<activityId>@ordinarydays.app` | Stable for the owner and participants across every edit. |

The `UID` never changes for the life of the token or the activity. Rotating a shareable link
deliberately produces a new `UID`, which is correct: it is a new invitation.

**`SEQUENCE` increments.** `SEQUENCE` must be a non-negative integer that increases whenever
a material property of the event changes, or clients will ignore the update.

- Add `icsSequence: number` to `Activity`, defaulting to `0`
  ([`../02-architecture/data-model.md`](../02-architecture/data-model.md) §4.1 amendment).
- It is incremented **once per write** that changes any of `schedule.date`, `schedule.time`,
  `schedule.endTime`, `schedule.timezone`, `location.label`, `location.address`, `title`, or
  `status`. Nothing else bumps it — a note edit or an added expense must not cause every
  guest's calendar to re-notify.
- The increment happens in the same `TransactWriteItems` as the change, with
  `ADD icsSequence :one`, so a concurrent edit cannot produce two writes at the same
  sequence.
- The comparison of "did a material field change" lives in one pure function,
  `materialIcsChange(before, after): boolean`, in `packages/shared`, and is the same function
  P5-21 uses to decide whether to send `plan_changed`.

**Edge cases.** An activity with no `schedule.date` has no exportable event: both `.ics`
endpoints return `409 conflict` with `This plan has no date yet.` A title containing only
whitespace falls back to `Plan`. A `DESCRIPTION` longer than 8,000 characters is truncated at
a word boundary before escaping.

**Tests.**

- Golden-file tests for: timed with end, timed without end, all-day, all-day multi-day,
  cancelled, a title containing `,` `;` `\` and a newline, a 300-character summary that must
  fold, and a summary containing emoji and CJK characters that must fold on an octet boundary
  without splitting a code point.
- Every golden file is additionally parsed by `ical.js` in the test, and the parsed
  `summary`/`location`/`startDate` are asserted to equal the inputs. This is the oracle that
  catches an escaping bug the golden file would have happily frozen in place.
- A property test: for any text containing arbitrary characters, `parse(build(text)) === text`
  after normalisation.
- `SEQUENCE` tests: `materialIcsChange` returns `true` for each of the eight listed fields and
  `false` for `notes`, `details.description`, participants, attachments and expenses.
- No output ever contains `ATTENDEE`, `ORGANIZER`, `RRULE`, `VTIMEZONE`, or `METHOD:REQUEST`
  — asserted as a regex over every golden file.

---

### P5-09 — Google Calendar template URL builder

**What to build.** A pure function producing the redirect target, with the host fixed in
code.

**Files.** `packages/shared/src/calendar/google.ts` and its tests.

**Approach.**

```
https://calendar.google.com/calendar/render
  ?action=TEMPLATE
  &text=<title>
  &dates=<start>/<end>
  &details=<description>
  &location=<location>
```

| Parameter | Value | Cap |
| --- | --- | --- |
| `action` | Literal `TEMPLATE` | — |
| `text` | `activity.title` | 200 chars |
| `dates` | Timed: `YYYYMMDDTHHMMSSZ/YYYYMMDDTHHMMSSZ` in UTC. All-day: `YYYYMMDD/YYYYMMDD` with an **exclusive** end date. | — |
| `details` | `details.description`, plus a final line `From <organiser display name>`, plus the invite URL | 1,000 chars |
| `location` | `location.address` if present, else `location.label` | 300 chars |

Rules:

- The base URL is a module constant. It is never assembled from configuration, a database
  value, or anything a user can influence.
- Every parameter value goes through `encodeURIComponent`. Spaces become `%20`, not `+`.
- No `ctz` parameter: the times are UTC and carry their own zone, so a `ctz` would be
  redundant and, if it disagreed with the instants, wrong.
- The finished URL is capped at 2,000 characters; if it exceeds that, `details` is truncated
  first, then `location`.
- The endpoint that issues the `302` re-validates that the target's host is exactly
  `calendar.google.com` before responding
  ([`../02-architecture/security-privacy.md`](../02-architecture/security-privacy.md) §4.1
  rule 9). An open redirect is an XSS vector with extra steps.

**Edge cases.** A missing end time uses start + 1 hour, matching the `.ics` default, so the
two exports never disagree. An all-day event's `dates` uses the exclusive end date; getting
this wrong produces an event a day short, which is the most common bug in this integration.

**Tests.** Golden URLs for timed, all-day, multi-day and no-end-time cases. A test asserting
every value is percent-encoded, including `&`, `#`, `+` and a newline in the title. A test
asserting the host cannot be changed by any input.

---

### P5-10 — Schemas for participants, invites, updates and the public projection

**What to build.** The Zod schemas, in `packages/shared`, used by both sides.

**Files.** `packages/shared/src/schemas/participant.ts`, `invite.ts`, `update.ts`,
`publicInvite.ts`; `packages/shared/src/constants.ts` (add `MAX_PARTICIPANTS = 50`,
`INVITE_EXPIRY_DAYS = 90`, `INVITE_TTL_GRACE_DAYS = 30`).

**Approach.** Request bodies are `.strict()`. The public projection schema is written as an
explicit object with every allowed key spelled out — never `.pick()` from the Activity
schema, because a `.pick()` silently keeps working when the source gains a field and that is
exactly the leak this schema exists to prevent.

```ts
export const publicInvite = z.object({
  plan: z.object({
    title: z.string(),
    date: isoDate.nullable(),
    time: hhmm.nullable(),
    endTime: hhmm.nullable(),
    timezone: ianaTimezone.nullable(),
    timezoneLabel: z.string().nullable(),          // "Eastern Time (US & Canada)"
    locationLabel: z.string().nullable(),
    locationAddress: z.string().nullable(),
    description: z.string().nullable(),            // details.description on `event` only
    coverImageUrl: z.string().url().nullable(),    // CloudFront URL of primaryAttachmentId
    ticketUrl: z.string().url().nullable(),
    priceCents: z.number().int().nonnegative().nullable(),
    currency: z.string().length(3).nullable(),
    status: z.enum(['scheduled', 'cancelled']),
  }).strict(),
  organiser: z.object({ displayName: z.string() }).strict(),
  rsvpCounts: z.object({
    going: z.number().int().nonnegative(),
    maybe: z.number().int().nonnegative(),
  }).strict(),
  you: z.object({
    displayName: z.string().nullable(),
    rsvp: z.enum(['pending', 'going', 'maybe', 'declined']).nullable(),
    isPersonalised: z.boolean(),
  }).strict(),
  calendar: z.object({ icsUrl: z.string().url(), googleUrl: z.string().url() }).strict(),
}).strict();
```

That object **is** the allow-list. Nothing outside it reaches a stranger.

**Tests.** A test that enumerates `Object.keys` of the schema's shape recursively and compares
it to a checked-in literal array. Adding a key to the schema without updating the array fails
CI, which is criterion S8's enforcement mechanism.

---

### P5-11 — Participant repository and the transaction budget

**What to build.** The write paths in
[`../02-architecture/data-model.md`](../02-architecture/data-model.md) §7 that involve
participants, sized so a transaction never approaches DynamoDB's limits.

**Files.** `services/api/src/repositories/participants.ts`,
`services/api/src/repositories/__tests__/participants.int.test.ts`.

**The budget.** `TransactWriteItems` allows **100 items** and **4 MB** per call, and — the
constraint that actually bites — **no two actions in one transaction may target the same
item**. Two participant additions in one transaction would both update
`ACT#<a>/META.participantCount` and the call fails with `ValidationException`.

| Write path | Items per unit | At the 50-participant cap | One transaction? |
| --- | --- | --- | --- |
| Add participant, app user | `ACT#/PART#`, `USER#<invitee>/IDX#`, `USER#<owner>/PLINK#`, `USER#<invitee>/PLINK#`, `USER#<invitee>/PERSON#` (reciprocal contact), `ACT#/META` counter | 6 | Yes |
| Add participant, guest with email | `ACT#/PART#`, `USER#<owner>/PERSON#`, `USER#<owner>/PLINK#`, `INVITE#<token>/META`, `GUESTEMAIL#<email>/OWNER#<ownerId>#PERSON#<id>`, `ACT#/META` counter | 6 | Yes |
| Add participant, guest without email | `ACT#/PART#`, `USER#<owner>/PERSON#`, `USER#<owner>/PLINK#`, `ACT#/META` counter | 4 | Yes |
| Create activity with `participants[]` | 2 base (`ACT#/META`, owner `IDX#`) + up to 6 per participant | 302 | **No** — see below |
| Reschedule | `ACT#/META` + one `IDX#` per participating **app user**, owner included | 52 | Yes |
| Remove participant | `ACT#/PART#` delete, their `IDX#` delete, both `PLINK#` deletes, `INVITE#` revoke, `ACT#/META` counter | 6 | Yes |
| Delete activity | Every item in the `ACT#` partition + every participant's `IDX#` + both directions of every `PLINK#` + list-item pointer clears | 200+ | **No** — see P5-24 |

> **Decision — creation fans out in batches, not in one transaction.** `POST /v1/activities`
> writes `ACT#/META` and the owner's `IDX#` in a two-item transaction and returns as soon as
> that succeeds. `participants[]` is then applied in further transactions of **at most eight
> participants each** (≤ 48 items, plus one `META` counter action per transaction, which is
> why the participants and not the items are what is batched). Each transaction is idempotent
> (`attribute_not_exists(sk)` on the `PART#` item) and carries a `ClientRequestToken` derived
> from the request's `Idempotency-Key` plus the batch index. If a batch fails, the activity
> exists and the response reports `participantsAdded` and `participantsFailed[]`; the client
> retries the failed ones as individual `POST .../participants` calls. An activity that
> exists with some participants is a recoverable state a user can see and fix. An activity
> that does not exist because participant seven had a stale `personId` is not.

Two further rules:

- The `ACT#/META` counter is updated with `ADD participantCount :n` where `:n` is the batch
  size, once per transaction. Never once per participant.
- `ClientRequestToken` is set on every `TransactWriteItems` call, derived deterministically
  from the request's `Idempotency-Key`. DynamoDB deduplicates identical tokens for 10
  minutes, which makes a mid-flight network retry safe at the storage layer as well as at
  the middleware layer.

**Edge cases.** A `personId` that is not in the owner's address book returns
`validation_failed`, not `404` — it is an input error, not a missing resource. Adding a
person who is already a participant is a no-op returning the existing `Participant` with
`200`, not `409`; re-tapping a name in the picker must not error.

**Tests.** Repository integration tests against DynamoDB Local: each row in the budget table
is asserted for item count; a two-participant single transaction is asserted to be rejected
(proving the batching is necessary and the code does not regress into it); a batch that fails
part-way leaves the activity and the earlier participants intact; a replayed
`ClientRequestToken` writes nothing the second time.

---

### P5-12 — `POST /v1/activities/:id/participants`

**What to build.** The one endpoint that turns a private activity into a shared one.

**Files.** `services/api/src/routes/participants.ts`,
`services/api/src/handlers/participants.ts`,
`services/api/src/services/participants.ts`.

**Approach.** Body is either `{ personId }` or `{ displayName, email? }`. The service:

1. `assertActivityAccess(userId, activityId, 'owner')`.
2. Enforces `participantCount < 50`, else `422 participant_limit_exceeded`.
3. Resolves or creates the `Person` in the **caller's** partition.
4. Decides guest vs app user: an email that matches an `EMAIL#<lowercased>` row belongs to a
   registered user, and the `Person` is created with `linkedUserId` set. An email with no
   match creates a guest and an `INVITE#` token.
5. Runs the appropriate transaction from P5-11.
6. Flips `activity.visibility` to `'shared'` if it is not already, in the same transaction.
   The flip is **one-way**; removing the last participant does not reverse it
   ([`../01-product/sharing-and-people.md`](../01-product/sharing-and-people.md) §2.1).
7. Writes a system update (`Ujjwal added Alice`), notifies the added person only, and
   returns the `Participant` plus, for a guest, `inviteUrl`.

**Edge cases.**

- The response must not reveal whether an email belongs to a registered user to anyone but
  the caller — and the caller is the one who typed it, so returning
  `participant.isGuest: false` is fine. There is still no endpoint that answers "does this
  address have an account" without adding the person to a plan
  ([`../02-architecture/security-privacy.md`](../02-architecture/security-privacy.md) §1
  row 13).
- Adding a person notifies **that person only**. No fan-out to existing participants
  (privacy rule P11).
- Adding yourself is a `validation_failed`.
- The owner is a `Participant` with `role: 'owner'` and `rsvp: 'going'`, written at activity
  creation, not on the first add.
- An activity that is `completed` or `cancelled` refuses new participants with `409`.

**Tests.** Route integration tests for: owner adds a contact; owner adds a new guest by name;
owner adds a guest by an email that matches a registered user (asserts `linkedUserId` is set
and an `ActivityIndex` appears in that user's partition); participant tries to add someone
(`403`); stranger tries (`404`); the 51st add (`422`); a duplicate add (`200`, idempotent);
`visibility` flips exactly once.

---

### P5-13 — `PATCH /v1/activities/:id/participants/:personId` — RSVP

**What to build.** The three-state RSVP, and what each state does to the invitee's Today.

**Files.** `services/api/src/services/participants.ts` (extend), plus the `ActivityIndex`
repository.

**Approach.**

| Response | Storage effect |
| --- | --- |
| `going` | `PART#.rsvp = 'going'`, `respondedAt` set. `IDX#` untouched. |
| `maybe` | Same with `'maybe'`. `IDX#` untouched. |
| `declined` | `PART#.rsvp = 'declined'` **and the invitee's `USER#/IDX#` item is deleted**, in one transaction. The plan leaves their Today, Plans and agenda. |

Re-accepting from the notification inbox recreates the `IDX#` entry with the correct GSI1
keys — so the write path must be able to reconstruct `gsi1pk`/`gsi1sk` from the activity,
which means the service reads `ACT#/META` first rather than trusting anything on the
`PART#` row.

Authorisation: a participant may change only their own; the owner may change anyone's
([`../01-product/sharing-and-people.md`](../01-product/sharing-and-people.md) §3.2). A
declined participant retains RSVP-change rights and nothing else — the authz helper treats
`declined` as a participant for this route and `404`s every other route (privacy rule P7).

**Edge cases.** Changing an RSVP after the plan's date is allowed. An RSVP change always
writes a system update and notifies the owner, including when the owner is the one changing
it on someone's behalf — in which case the update reads `Ujjwal marked Alice as going`, not
`Alice is going`, because the app must not attribute a statement to someone who did not make
it.

**Tests.** Each transition; the `IDX#` delete on decline and its restoration on re-accept;
participant cannot change another's; owner can; a declined participant gets `404` from
`GET /v1/activities/:id`; the system-update wording differs for self versus owner-relayed.

---

### P5-14 — `DELETE /v1/activities/:id/participants/:personId` — remove and leave

**What to build.** Two operations behind one route: the owner removing someone, and a
participant leaving.

**Approach.** Removing revokes that person's personalised invite token in the same
transaction, deletes their `IDX#` and both `PLINK#` rows, and decrements the counter.
Leaving does the same for the caller and writes a `participant_left` inbox entry for the
owner. Removal is confirmed in the UI and has **no undo**
([`../01-product/interaction-contract.md`](../01-product/interaction-contract.md) §4.1);
re-adding sends a fresh invitation with a new token.

**Edge cases.** The owner cannot be removed and cannot leave; the only exit is deleting the
plan. Removing a person who has expenses on the plan is allowed and does **not** delete the
expenses — the arithmetic must still reconcile
([`../01-product/expenses.md`](../01-product/expenses.md) §4). Their name stays on the
expense rows. This is stated here because the obvious implementation deletes too much.

**Tests.** Owner removes; participant leaves; participant cannot remove another; the token is
`410` immediately after removal; expenses survive removal; the owner cannot leave.

---

### P5-15 — Shareable invites

**What to build.** `POST /v1/activities/:id/invites` (no `personId`) and
`DELETE /v1/activities/:id/invites/:token`.

**Approach.** A shareable invite is an `INVITE#<token>` row with no `personId`. Whoever opens
it supplies a name at RSVP time, which creates a `Person` and a `Participant` in the owner's
partition at that moment (P5-17). Owner-only on both routes. The response is
`{ token, url, expiresAt }`.

**Edge cases.** An activity may hold at most **five** live shareable invites; rotation is
`POST` a new one then `DELETE` the old. Personalised tokens are not rotatable — remove and
re-add the person. A shareable invite on an activity with no date expires 90 days after
creation rather than 90 days after the date.

**Tests.** Create, list on the activity detail, revoke, `410` after revoke, the five-invite
cap, non-owner gets `404`.

---

### P5-16 — The public invite projection and `GET /public/v1/invites/:token`

**What to build.** The single most security-sensitive handler in the product.

**Files.** `services/api/src/routes/public/invites.ts`,
`services/api/src/services/publicInvite.ts` — containing `toPublicInvite()` and nothing else.

**Approach.** The projection function takes the loaded `Activity`, `Participant[]`, the owner's
`User`, and the `Invite`, and returns the `publicInvite` object **field by field**. It never
spreads, never `pick`s, never iterates over the source object's keys. It lives in its own file
with no other exports so a reviewer can read the whole thing at once.

Exactly these fields are returned; this list is the same one in
[`../01-product/sharing-and-people.md`](../01-product/sharing-and-people.md) §4.2 and is
restated here because it is the implementation contract:

| Returned key | Source | Condition |
| --- | --- | --- |
| `plan.title` | `activity.title` | Always |
| `plan.date`, `plan.time`, `plan.endTime`, `plan.timezone`, `plan.timezoneLabel` | `activity.schedule` | Null when unscheduled |
| `plan.locationLabel` | `activity.location.label` | Null when absent |
| `plan.locationAddress` | `activity.location.address` | Null when absent |
| `plan.description` | `activity.details.description` | **`event` type only.** Never `activity.notes`, on any type |
| `plan.coverImageUrl` | CloudFront URL for `activity.primaryAttachmentId` | Null when absent |
| `plan.ticketUrl`, `plan.priceCents`, `plan.currency` | `activity.details` | `event` type only |
| `plan.status` | `'scheduled'` or `'cancelled'` | Derived; every other status maps to `'scheduled'` |
| `organiser.displayName` | The owner's `User.displayName` | Always. Never their email. |
| `rsvpCounts.going`, `.maybe` | Counted from `Participant[]` | Aggregates only |
| `you.displayName`, `you.rsvp`, `you.isPersonalised` | The invite's `personId`, if set | Null for a shareable link |
| `calendar.icsUrl`, `calendar.googleUrl` | Constructed from the token | Always |

Never returned, under any circumstance — the deny list from
[`../01-product/sharing-and-people.md`](../01-product/sharing-and-people.md) §4.3, restated
as assertions the test file makes: `activity.notes`; any expense field including
`expenseTotalCents`; any individual participant's name, email, avatar or RSVP; any email
address at all including the organiser's; any `userId`, `personId`, `activityId`, or other
internal identifier; any other activity of the owner's including prep tasks and children; any
list or list item; any attachment other than the single cover; the updates feed; `recurrence`,
`reminders`, or occurrence data; `location.lat`/`location.lng` when `location.address` is
absent; `sourceUrl` unless it is `details.ticketUrl`.

Response codes: `404` for an unknown token with a body identical to every other `404`; `410
invite_expired` past expiry; `410 invite_revoked` when revoked. Both `410`s return **no plan
data at all** — not the title, not the date.

**Edge cases.** A cancelled plan still resolves, with `plan.status: 'cancelled'`; the page
renders a cancelled banner and hides the RSVP control, because a guest reading "cancelled" is
strictly better than a guest reading `410`. Coordinates without an address are dropped
(privacy rule P10). An activity whose owner has been soft-deleted resolves with
`organiser.displayName` intact ([`../02-architecture/auth.md`](../02-architecture/auth.md)
§8).

**Tests.** The snapshot allow-list test from P5-10 runs against a fully-populated fixture — an
activity with notes, three expenses, five participants with emails, four attachments, two
lists, a recurrence, and `lat`/`lng` but no address — and asserts the serialised response
matches a checked-in JSON file byte for byte. Adding a field anywhere upstream fails this
test, which is criterion S8. Separate tests for each `410`, for the deny list applied to a
cancelled plan, and for a non-`event` type never emitting `description`.

---

### P5-17 — `POST /public/v1/invites/:token/rsvp`

**What to build.** The three-tap path that is success criterion S4.

**Approach.**

- Personalised token: `{ response }` alone is sufficient. Updates the existing `Participant`.
- Shareable token: `{ response, displayName, email? }`. `displayName` is required; on first
  use it creates a `Person` and a `Participant` in the **owner's** partition. Repeat visits
  from the same browser are identified by a `guestKey` — an opaque value the page stores in
  `localStorage` and sends back — so a guest changing their answer updates their row rather
  than creating a second one.

Every response writes a system update and notifies the owner (`rsvp_guest`). Rate limits from
P5-06 apply. `Cache-Control: no-store`.

**Edge cases.** A guest may change their answer any number of times; the page always shows
the current one. A shareable link used by 51 distinct people hits the participant cap and
returns `422` with `This plan is full.` — the only public error that says anything about the
plan's state, and it is unavoidable. `email` is optional and labelled as such; supplying it
enables plan-change emails and nothing else. The `guestKey` is never a cookie, so there is no
consent banner.

**Tests.** Playwright: open link, tap `Going`, see confirmation — asserted under three taps
and, with a throttled network profile, under 30 seconds (S4). Integration: personalised and
shareable paths; the `guestKey` de-duplication; the participant cap; the per-token rate limit.

---

### P5-18 — `.ics` endpoints, public and authenticated

**What to build.** `GET /public/v1/invites/:token/ics` and `GET /v1/activities/:id/ics`.

**Approach.** Both call `buildIcs` with the fields from the same projection used by the
surface they sit on — the public endpoint uses the P5-16 projection, so it cannot export a
field the page does not show. Headers:

| Header | Value |
| --- | --- |
| `Content-Type` | `text/calendar; charset=utf-8; method=PUBLISH` |
| `Content-Disposition` | `inline; filename="<slug>.ics"` by default; `attachment; filename="<slug>.ics"` when `?download=1` |
| `Cache-Control` | `no-store` |

`inline` is what makes iOS hand the file to Calendar directly rather than downloading it;
`attachment` is the desktop `Download .ics` button. The filename slug is derived from the
title, ASCII-only, capped at 40 characters, defaulting to `plan`.

**Edge cases.** No date → `409`. A revoked or expired token → the same `410`s as P5-16, with
no calendar body. The authenticated endpoint is available to the owner and participants; a
stranger gets `404`.

**Tests.** Header assertions; the file parses under `ical.js`; the `UID` differs between the
two surfaces and is stable across two calls; `SEQUENCE` increases after a reschedule and does
not after a note edit.

---

### P5-19 — Google Calendar redirect endpoint

**What to build.** `GET /public/v1/invites/:token/calendar/google`.

**Approach.** Loads the same projection, builds the URL with P5-09, asserts the host is
`calendar.google.com`, and returns `302` with `Location` and `Cache-Control: no-store`. No
body. The authenticated equivalent is not a separate endpoint: the client builds the same URL
locally from data it already has.

**Tests.** `302` with a well-formed `Location`; `410` paths return no `Location` header at
all; a test that mutates the builder's base URL constant and asserts the handler refuses to
redirect.

---

### P5-20 — Updates feed: read, write, and server-side system entries

**What to build.** `GET`/`POST /v1/activities/:id/updates`, plus the system-entry writer that
every other task in this phase calls.

**Files.** `services/api/src/routes/updates.ts`,
`services/api/src/services/updates.ts` — exporting `writeSystemUpdate(kind, activityId, ctx)`.

**Approach.** Entries are `ACT#<a>/UPD#<isoTs>#<updateId>` and are read newest-first with
cursor pagination. `kind` is `'user'` or `'system'`. System entries carry a `code` and a
structured `params` object; the display string is rendered **client-side** from the strings
module so it can be localised later and so a stored string cannot go stale when a person is
renamed.

System entry codes shipped in this phase:

| Code | Written by | Rendered as |
| --- | --- | --- |
| `participant_added` | P5-12 | `Ujjwal added Alice` |
| `participant_removed` | P5-14 | `Ujjwal removed Ben` |
| `participant_left` | P5-14 | `Ben left` |
| `rsvp_set` | P5-13, P5-17 | `Alice is going` |
| `rsvp_set_by_owner` | P5-13 | `Ujjwal marked Alice as going` |
| `schedule_changed` | P5-21 | `Time changed to 8:00 PM` |
| `location_changed` | P5-21 | `Moved to Suraya` |
| `renamed` | P5-21 | `Renamed to Dinner at Suraya` |
| `cancelled` / `uncancelled` | P5-21 | `Cancelled` / `Cancellation undone` |

**Edge cases.** Participants may post; nobody may delete another's post; the author may delete
their own. The feed is capped at 500 entries per activity, after which the oldest system
entries (never user entries) are trimmed by the maintenance job. Guests never read or write
the feed.

**Tests.** Pagination; authorisation (`participant` can post, guest cannot, stranger `404`);
the writer produces a structured `params` object with no pre-rendered string; deleting
another's entry is `403`.

---

### P5-21 — Change detection and plan-change notifications

**What to build.** The one place that decides "this change is worth interrupting someone
for".

**Approach.** `PATCH /v1/activities/:id` and `POST .../schedule` capture the activity before
and after, then call one pure function:

```ts
classifyChange(before, after): {
  material: boolean;          // drives icsSequence and plan_changed
  codes: SystemUpdateCode[];  // drives the feed
  notify: NotificationKey[];  // drives push, inbox and guest email
}
```

| Change | Feed | Push to app users | Email to guests | `icsSequence` |
| --- | --- | --- | --- | --- |
| `schedule.date`/`time`/`endTime`/`timezone` | `schedule_changed` | `plan_changed` | Yes | Bump |
| `location.label`/`address` | `location_changed` | `plan_changed` | Yes | Bump |
| `title` | `renamed` | `plan_renamed` (inbox only, no push) | No | Bump |
| `status → cancelled` | `cancelled` | `plan_cancelled` | Yes | Bump |
| `notes`, `details.*` other than the above, attachments, prep tasks | Nothing | Nothing | No | No |

Fan-out reads the participant list from the `ACT#` partition once and dispatches: push per
app user with a registered device, an inbox entry per app user regardless of push, and one
SES send per guest **with an email and a live token**. Quiet hours are applied by the existing
notification service, with the documented exception that a cancellation of a plan starting
within 12 hours is delivered immediately
([`../01-product/notifications.md`](../01-product/notifications.md) §4).

**Edge cases.**

- A single `PATCH` that changes the time *and* the location produces **one** `plan_changed`
  notification, one email, one `icsSequence` bump, and two feed entries. Nobody gets two
  pushes for one edit.
- A change made by the owner does not notify the owner.
- A muted plan suppresses every push for that user without affecting anyone else's.
- Uncancelling re-notifies, per
  [`../01-product/interaction-contract.md`](../01-product/interaction-contract.md) §4.1.
- A private activity (no participants) notifies nobody and writes no feed entry.

**Tests.** A table-driven test over `classifyChange` covering every field in the model,
asserting `material`, `codes` and `notify` for each. Integration tests asserting exactly one
push and one email per multi-field edit, zero notifications on a private activity, and that a
guest with a revoked token receives nothing.

---

### P5-22 — Invitation and RSVP notifications, inbox entries, invitation reminder

**What to build.** `invitation_received`, `invitation_reminder`, `rsvp_changed`, `rsvp_guest`,
`plan_update_posted`, `prep_task_completed`, `participant_left`, per
[`../01-product/notifications.md`](../01-product/notifications.md) §7.

**Approach.** Inbox entries are written for every interpersonal event regardless of whether a
push was sent, suppressed by a category toggle, or held by quiet hours. `invitation_reminder`
is scheduled through EventBridge Scheduler at `scheduledAtUtc - 24h` when a participant is
added, keyed `inv_<activityId>_<personId>`, and is cancelled when they respond, when they are
removed, or when the plan is deleted or cancelled. It fires once and only while
`rsvp === 'pending'`.

An invitation inbox entry carries inline `Going · Maybe · Decline`; acting from the inbox is
identical to acting on the plan.

**Edge cases.** A user with no registered device still gets the inbox entry. Reminders never
create inbox entries. The `held_digest` path already exists from Phase 4 and must be
exercised by the new categories.

**Tests.** Each catalogue entry produces the right push/inbox combination; the invitation
reminder is cancelled on every one of the four cancelling events; a user who declined and then
re-accepts from the inbox regains the plan on Today.

---

### P5-23 — Invite lifetime: expiry, revocation, TTL, rotation

**What to build.** The lifecycle table in
[`../01-product/sharing-and-people.md`](../01-product/sharing-and-people.md) §4.6, made real.

**Approach.**

- `expiresAt` = plan date + 90 days, or creation + 90 days when unscheduled.
- `ttl` = `expiresAt` + 30 days, so DynamoDB removes the row for free and the token then
  resolves `404` instead of `410`.
- Rescheduling **recomputes** `expiresAt` and does not revoke.
- Removing a participant, deleting the plan, or hitting the opt-out link sets `revoked: true`.
- Expiry is evaluated in the handler against the current time, never by relying on TTL —
  TTL deletion is best-effort within 48 hours and must never be a security control.

**Tests.** Expired, revoked, unknown and live tokens each produce the right status and body; a
reschedule extends `expiresAt` and leaves `revoked` false; deleting a plan revokes every one
of its tokens including shareable ones.

---

### P5-24 — Participant-aware fan-out: reschedule and the delete cascade job

**What to build.** The two multi-item writes that grow with the participant list.

**Approach.**

**Reschedule.** One transaction: `ACT#/META` plus one `IDX#` per participating app user
(GSI1 sort keys change with the date). At the 50-participant cap this is 52 items, inside the
100 limit. Guests have no `IDX#`, so they cost nothing here.

**Delete.** Cannot be one transaction. Two phases:

1. **Tombstone**, transactional, two items: set `ACT#/META.deletedAt` and delete the owner's
   `IDX#`. From this instant the plan is gone from every read path, because every read either
   goes through GSI1 or checks `deletedAt`.
2. **Cascade**, a resumable job keyed by a `USER#<owner>/DELJOB#<activityId>` item. It pages
   the `ACT#` partition and issues `BatchWriteItem` calls of 25, deleting participants,
   expenses, updates, occurrences and attachments, then deletes each participant's `IDX#` and
   both directions of every `PLINK#`, revokes every `INVITE#`, and clears
   `listItem.linkedActivityId` on any linked list item. It records progress on the job item
   and is safe to run twice.

The cascade runs inline for small plans (fewer than 60 items total, which is the common case)
and is handed to the maintenance job when it is larger, so a delete never times out a 15-second
Lambda.

**Edge cases.** S3 attachment objects are deleted in the cascade; a failure there is logged and
retried by the maintenance job rather than blocking the row deletes. A `DELJOB#` older than 24
hours with incomplete progress raises an alarm — an orphaned partition is a data-retention
problem, not just an untidy one.

**Tests.** Delete of a plan with 50 participants, 20 expenses, 40 updates and 3 attachments
removes every item and every index entry; the job resumes correctly when killed mid-way; the
plan is invisible immediately after phase one; a linked list item survives with a cleared
pointer.

---

### P5-25 — Guest → account linking and the `GUESTEMAIL#` partition

**What to build.** The path from "Chloe was invited by email" to "Chloe signs up and her plans
are already there". Closes OQ-9.

**Files.** `services/api/src/repositories/guestEmail.ts`,
`services/api/src/services/linking.ts`, the Cognito post-confirmation trigger.

**Approach.**

- Every time a guest `Person` is written with an email, also write
  `GUESTEMAIL#<lowercased-email>` / `OWNER#<ownerId>#PERSON#<personId>` holding `{ ownerId, personId }`.
  Removing the email or deleting the person removes the row. This is the index that makes
  linking possible without a `Scan`.
- On post-confirmation with `email_verified === true`, the trigger:
  1. Writes `EMAIL#<lowercased>` → `USER`.
  2. Queries `GUESTEMAIL#<lowercased>` for every `{ ownerId, personId }` pair.
  3. For each, sets `person.linkedUserId`, creates the reciprocal `Person` for the owner in
     the new user's address book, and writes an `ActivityIndex` entry in the new user's
     partition for every **non-completed, non-cancelled** activity that person participates
     in (found via `PLINK#<personId>#`).
- Bounded work: the trigger has a five-second Cognito budget. It links at most the first 50
  activities inline; beyond that it writes `USER#<u>/LINKJOB#<ulid>` and the maintenance job
  finishes it. A trigger that times out **fails the sign-up**, which is far worse than a
  delayed link.

Rules, restated because each has been got wrong before:

- Verified email only. The trigger reads the `email_verified` claim and does nothing without
  it.
- No merge prompt on the new user's side, and the owner is **not** notified.
- Completed and cancelled activities are not back-filled.
- `personId` never changes, so expenses and balances continue to reconcile and simply become
  visible from the other side.
- Phone numbers are never a linking key.
- Every link logs `userId`, `ownerId`, `personId`, `activityId` and the **hashed** email.

**Edge cases.** The same email may be a guest in several owners' address books; all of them
link. An owner adding an email to an existing guest `Person` that matches a registered user
links immediately on save, with the same effects. A user who deletes their account and signs
up again with the same address links again — which is correct.

**Tests.** Integration: a guest on three plans across two owners signs up and finds three
plans on Today and two new contacts; an unverified email links nothing; 60 matched activities
produce 50 inline plus a `LINKJOB#`; the trigger completes in under two seconds against
DynamoDB Local with 50 matches; removing a guest's email removes the `GUESTEMAIL#` row.

---

### P5-26 — Authorisation matrix enforcement and its test walk

**What to build.** One test file that walks the entire matrix in
[`../01-product/sharing-and-people.md`](../01-product/sharing-and-people.md) §3.4 with four
actors — owner, participant, declined participant, stranger — and one more for guests via
token.

**Approach.** The matrix is encoded as data, not as 60 hand-written tests. A fixture builds
one shared plan and one private plan and then asserts, for every route and actor, the exact
status code. A route added without a matrix row fails the test, because the test enumerates
the Hono router's registered routes and asserts every one has a row.

**Tests.** The matrix itself. Plus: a stranger always gets `404`, never `403`; a participant
gets `403` (not `404`) for owner-only actions on a plan they can see; `notes` is stripped for
non-owners on `GET /v1/activities/:id` (privacy rule P9).

---

### P5-27 — Minimal People read surface for the picker

**What to build.** Just enough of the People API for the picker to work. The People page,
Person view, balances and the FREQUENT ranking are Phase 6.

**Approach.** `GET /v1/people` returns every `PERSON#` row for the caller, name-sorted, with
`upcomingCount` and `lastActivityAt`. `GET /v1/people/suggested` returns
`{ frequent: [], recent: [...] }` — RECENT is people with a shared activity in the last 30
days, ordered by `lastActivityAt`, capped at 8, computed from `PLINK#` rows. `frequent` ships
empty in this phase and the picker renders no FREQUENT heading when it is; Phase 6 fills it.
Search is a client-side substring match over `GET /v1/people` until the list justifies a
server-side one.

`upcomingCount` and `lastActivityAt` are maintained on every participant write and on every
reschedule, in the same transaction.

**Tests.** RECENT window boundaries at exactly 30 days; ordering; the cap; counters updated on
add, remove, reschedule and completion.

---

### P5-28 — The participant picker sheet

**What to build.** The sheet in
[`../01-product/sharing-and-people.md`](../01-product/sharing-and-people.md) §2.2, on both
platforms.

**Files.** `apps/mobile/src/features/people/components/ParticipantPicker.tsx`,
`.../hooks/useSuggestedPeople.ts`, `.../model/pickerState.ts`.

**Approach.** One search field, selected chips above the buckets, FREQUENT and RECENT lists,
and a `+ Add "<name>" as a new person` row when nothing matches. Selection is applied on
`Done`: one `POST .../participants` per person on an existing activity, or held in local state
and sent inside `CreateActivityInput.participants[]` on a new one. The 51st selection is
refused inline with `You can add up to 50 people to a plan.` and never reaches the network.

**Edge cases.** Typing a valid email that matches a registered user shows a `Has the app`
badge — which is safe because the caller typed the address. Partial failure of a multi-person
add leaves the succeeded ones selected and shows one banner naming the failures with a
`Retry`. Keyboard support per
[`../01-product/interaction-contract.md`](../01-product/interaction-contract.md) §7.2:
`↑`/`↓` moves, `Return` toggles, `Esc` closes with the discard prompt if dirty.

**Tests.** Component tests for selection, de-selection, the cap, the new-person inline form,
and the empty state. A Maestro flow adding two people to an existing plan. Accessibility:
every row is one element labelled `Alice, selected` / `Alice, not selected` with a
`checkbox` role.

---

### P5-29 — Plan detail: PEOPLE section, share sheet, invite-link affordances

**What to build.** The PEOPLE section of the plan detail
([`../01-product/plans-and-lists.md`](../01-product/plans-and-lists.md) §2.1 item 3) and the
`Share` header action.

**Approach.** Each participant row shows the display name, RSVP state in words, and a `guest`
badge where applicable. The owner's swipe actions are `Resend invite`, `Copy link`, `Remove`,
all also present in the row's `⋯` menu. `Share` opens the picker; a secondary
`Copy invite link` creates or reuses a shareable invite. Tapping a participant row opens that
Person's view — which in this phase is a minimal screen showing the name, the `Has the app`
badge, and the shared-plans list; Phase 6 fills in the rest.

**Tests.** Component tests per row state; the owner-only actions are absent for a participant;
a guest row shows the copyable link; `Remove` shows a confirmation and offers no undo.

---

### P5-30 — RSVP affordances on agenda rows and in the inbox

**What to build.** The inline `Going · Maybe · Decline` control on a pending row, and the
same control on an invitation inbox entry.

**Approach.** Per
[`../01-product/interaction-contract.md`](../01-product/interaction-contract.md) §3.1: swipe
right sets `going`, swipe left partial reveals `Maybe` and `Decline`, and the row body still
opens the plan. The mutation is optimistic with a 6-second undo toast, and `declined` removes
the row from Today immediately. Subtitle shows `From Alice` when the plan has no location.

**Tests.** Optimistic apply and rollback on failure; the row disappears on decline and returns
on undo; accessibility actions expose all three responses without swiping.

---

### P5-31 — Updates feed UI

**What to build.** The UPDATES section of the plan detail, newest first, with a composer.

**Approach.** System entries render from `code` + `params` through the strings module. User
entries show the author's display name and a relative timestamp. The author may delete their
own entry via swipe. Posting is optimistic. The section is hidden on a private plan with no
entries.

**Tests.** Rendering of each system code; pagination; the author-only delete; an unknown
future `code` renders a neutral fallback rather than crashing — a shipped client must survive
a server that learned a new code.

---

### P5-32 — Add-to-calendar affordance on plan detail

**What to build.** `Add to calendar` in the plan's `⋯` menu, offering Google, Apple and
`Download .ics`.

**Approach.** iOS: `Apple` fetches `/v1/activities/:id/ics` and hands the file to the system,
which opens Calendar. Web: `Apple`/`Download` triggers the same URL with `?download=1`;
`Google` opens the built URL in a new tab. Nothing calls the public endpoints from an
authenticated screen.

**Tests.** Platform-branched unit tests for the URL chosen; a Playwright assertion that the
downloaded file's `Content-Type` is `text/calendar`.

---

### P5-33 — The public invite page

**What to build.** `apps/mobile/app/invite/[token].tsx`, the only unauthenticated screen in
the product.

**Approach.** Pre-rendered by the static export so the route has a real HTML file that
CloudFront serves and a crawler can read; the plan data is fetched client-side from
`/public/v1/invites/:token` and is never baked into the HTML. Layout per
[`../01-product/sharing-and-people.md`](../01-product/sharing-and-people.md) §4.2. Hard rules:

- No cookie banner, no interstitial, no "get the app" overlay, no modal, no email wall.
- One unobtrusive `Made with Ordinary Days` line at the foot, below the fold.
- `410` and `404` render a single line and nothing about the plan.
- The page never imports the authenticated API client, the auth provider, the query
  persister, or anything that reads a token. A test asserts the route's bundle contains no
  reference to the auth module.
- Respects `prefers-reduced-motion`, works at 320 px, and passes the contrast rules in
  [`../01-product/interaction-contract.md`](../01-product/interaction-contract.md) §6.4.

**Tests.** Playwright: the S4 flow; the expired and revoked pages; a cancelled plan's banner;
axe-core with zero violations; a bundle-content assertion for the auth module; a test that the
page works with `localStorage` disabled (the `guestKey` degrades to a new row per visit, which
is acceptable and must not throw).

---

### P5-34 — E2E and projection-leak tests, S4 and S8

**What to build.** The CI gates for the two success criteria this phase owns.

**Approach.** Add to `ci.yml` a job that runs the public-projection snapshot test (S8) and to
`deploy-dev.yml` a Playwright project that runs the guest RSVP flow against the deployed dev
environment with a throttled network profile and asserts the elapsed time (S4). Add a Maestro
flow covering: owner adds a guest by email → copies the link → the link resolves → RSVP →
the owner receives the notification.

**Tests.** These are the tests.

---

## Acceptance criteria

1. Adding the first participant to any activity of any type flips `visibility` to `shared`,
   and removing the last participant leaves it `shared`.
2. An app user added to a plan receives a push, an inbox entry, and the plan on their Today
   with `rsvp: 'pending'` and an inline three-button RSVP control, within one agenda refresh.
3. Setting `declined` removes the plan from the invitee's Today, Plans and agenda, and
   re-accepting from the inbox restores it with the correct GSI1 sort key.
4. A guest with an email receives one SES message containing a working link and an opt-out
   line; the opt-out link revokes their token and stops all further mail about that plan.
5. `GET /public/v1/invites/:token` returns exactly the keys in the P5-10 schema. The
   snapshot test against a fully-populated fixture fails if any key is added.
6. `GET /public/v1/invites/:token` never returns `notes`, an expense figure, an individual
   participant's name or RSVP, any email address, any internal identifier, coordinates
   without an address, or the updates feed — asserted individually.
7. An unknown token returns `404`; an expired one `410 invite_expired`; a revoked one
   `410 invite_revoked`. The two `410` bodies contain no plan data.
8. Invite tokens are 22 base62 characters from 128 bits of `crypto.randomBytes`; 100,000
   generated tokens are all distinct and all match `/^[0-9A-Za-z]{22}$/`.
9. `/public/v1/*` is limited to 30 requests per minute per hashed IP, and the RSVP route to
   10 attempts per hour per token. Both return `429` with `Retry-After`. A DynamoDB failure
   in the limiter fails open, not closed.
10. No public response carries `Set-Cookie`, `Access-Control-Allow-Credentials`, or a
    cacheable `Cache-Control`.
11. A guest can go from opening the link to a confirmed RSVP in three taps and under 30
    seconds on a throttled connection (S4).
12. The generated `.ics` parses under an independent parser, uses CRLF, folds at 75 octets
    without splitting a multi-byte character, escapes `\` `;` `,` and newline in text values,
    and contains no `ATTENDEE`, `ORGANIZER`, `RRULE`, `VTIMEZONE`, or `METHOD:REQUEST`.
13. The public `.ics` `UID` is `<token>@ordinarydays.app` and the authenticated one is
    `<activityId>@ordinarydays.app`; both are stable across repeated calls and across edits.
14. `SEQUENCE` increases on a change to date, time, end time, timezone, location label,
    address, title or status, and does not change on a note, description, attachment,
    participant or expense edit.
15. `GET /public/v1/invites/:token/calendar/google` returns `302` to a URL whose host is
    exactly `calendar.google.com`, with every parameter percent-encoded and an exclusive end
    date for all-day plans.
16. SES production access is granted for the prod account; `aws sesv2 get-account` reports
    `ProductionAccessEnabled: true` and the prod deploy fails if it does not.
17. `ordinarydays.app` has three passing Easy DKIM CNAMEs, a custom MAIL FROM subdomain with
    an MX and an SPF record, and a `_dmarc` TXT record. An external check (`dig`, plus a
    test message to a mailbox that reports authentication results) shows `dkim=pass`,
    `spf=pass` and `dmarc=pass` with aligned domains.
18. A bounce rate above 5% or a complaint rate above 0.1% raises an alarm to the confirmed
    SNS subscription.
19. Adding a participant writes at most six items in one transaction; creating an activity
    with 50 participants completes with the activity created and reports per-participant
    results; no transaction in the codebase targets the same item twice.
20. Deleting a plan with 50 participants, 20 expenses and 40 updates removes every item,
    every `ActivityIndex`, every `PLINK#`, and every invite token, and is resumable if
    interrupted.
21. Exactly three SES send functions exist. A test enumerating the email service's exports
    fails if a fourth appears.
22. A guest who signs up with a verified email that matches their guest record finds the
    non-completed plans they were invited to on their own Today, with no prompt, no
    duplicate, and no notification to the owner. Their `personId` is unchanged.
23. Sign-up completes in under two seconds with 50 matched activities, and more than 50
    produces a `LINKJOB#` item the maintenance job finishes.
24. A single `PATCH` changing both time and location produces one `plan_changed` push per
    app user, one email per guest, one `icsSequence` bump and two feed entries.
25. A stranger gets `404` on every activity-scoped route; a participant gets `403` on
    owner-only routes; the route-enumerating matrix test covers every registered route.
26. The public invite page's route bundle contains no reference to the authentication module,
    and the page renders and functions with `localStorage` unavailable.

## Out of scope for this phase

Each of these is tempting here and belongs elsewhere.

| Not in Phase 5 | Where it belongs |
| --- | --- |
| Expenses, splits, balances, settlement, the plan owes summary | Phase 6 |
| The People page, the full Person view, FREQUENT ranking, `POST /v1/people`, merge | Phase 6 |
| DynamoDB Streams — the stream is not enabled until Phase 6 | Phase 6 |
| Two-way calendar sync, reading the user's calendar, subscribing to a feed URL | Not planned ([`../01-product/overview.md`](../01-product/overview.md) §6) |
| `METHOD:REQUEST`, `ATTENDEE` lines, or an email-based RSVP reply channel | Never |
| A recurring-series `.ics` export with `RRULE` and `VTIMEZONE` | Not planned |
| Guests reading anything beyond the public projection — no guest expense view, no guest feed | [`../01-product/expenses.md`](../01-product/expenses.md) §6.6 |
| Comments, threads, reactions, direct messages between people | Never ([`../01-product/sharing-and-people.md`](../01-product/sharing-and-people.md) §7) |
| Contact-list import or address-book sync | Never |
| Web push for invitations | Not in v1 ([`../01-product/notifications.md`](../01-product/notifications.md) §6.2) |
| Participants adding attachments | Not in v1 |
| Marketing email, digests, re-engagement sends, or any fourth SES template | Never |
| AWS WAF on the public surface | Only on observed abuse (ADR-022) |

## Risks and gotchas

| # | Risk | Mitigation |
| --- | --- | --- |
| 1 | **SES production access takes days and blocks the end of the phase.** | Submit P5-02 on day one. Everything else is built against the dev sandbox with a verified recipient. Do not sequence it late. |
| 2 | **DKIM CNAMEs propagate slowly.** Requesting production access before DKIM shows `SUCCESS` invites a rejection. | Poll `get-email-identity` and gate P5-02 on it. |
| 3 | **A single-account SES reputation is shared between dev and prod.** A dev test blast damages prod deliverability. | Dev sends only to verified addresses, the sandbox stays on in dev permanently, and the send-spike alarm is account-wide. |
| 4 | **The public projection is a leak waiting to happen.** Any future field added to `Activity` for an authenticated screen is one careless spread away from a stranger. | The projection is built field by field in a file with one export; the snapshot test uses an explicit key allow-list; the deny list is asserted item by item. |
| 5 | **`TransactWriteItems` fails when two actions touch the same item.** The obvious loop-over-participants implementation hits this on the second participant. | The budget table, the batch-of-eight decision, and a test that asserts a two-participant single transaction is rejected. |
| 6 | **`.ics` escaping and folding are easy to get subtly wrong** and the failure mode is "Outlook shows a blank event" months later. | Golden files plus an independent parser oracle plus a property test. Never string concatenation. |
| 7 | **A `SEQUENCE` that bumps on every write** makes every note edit re-notify every guest's calendar. | `materialIcsChange` is a single pure function shared by the `.ics` and notification paths, table-tested over every field. |
| 8 | **The Google Calendar redirect is an open-redirect vector** if the base URL ever becomes data. | The host is a module constant, re-validated in the handler, with a test that mutates the constant and asserts refusal. |
| 9 | **Guest linking without an index needs a `Scan`**, which is banned and would be discovered only at implementation time. | `GUESTEMAIL#` is specified here and is already in the data model, §3.4 and access pattern 14b (OQ-9). |
| 10 | **A slow post-confirmation trigger fails sign-up.** Cognito's budget is five seconds. | 50-activity inline cap, `LINKJOB#` continuation, and a performance test against DynamoDB Local. |
| 11 | **Deleting a large shared plan exceeds the transaction limit and the Lambda timeout.** | Two-phase tombstone-then-cascade with a resumable job item and an alarm on stale jobs. |
| 12 | **Notification fan-out is where duplicate pushes are born.** | One `classifyChange` call per request, one dispatch, tested by asserting exact push and email counts on a multi-field edit. |
| 13 | **A rate limiter that fails closed takes down the invite page** for everyone during a DynamoDB blip. | Fail open on limiter errors, log at `error`, alarm on the log pattern. |
| 14 | **Shareable links and `localStorage`-based guest identity** produce duplicate participants when a guest opens the link on a second device. | Documented and accepted: the owner sees two rows and can merge them in Phase 6. Do not build device fingerprinting. |
| 15 | **The 50-participant cap interacts with a shareable link** — the 51st stranger gets a hard error on a page that otherwise never fails. | Explicit copy (`This plan is full.`) and a test; the owner sees the cap on the plan detail before it is reached. |
