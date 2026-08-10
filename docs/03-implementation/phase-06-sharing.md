# Phase 6 — Sharing, invites and shared lists

## Goal

At the end of this phase a plan stops being a private note and becomes a thing two or more
people can coordinate around. An owner can add people to a Plan from one picker;
app users receive an in-app invitation, a push, and the plan on their own Today with a
pending RSVP; everyone else receives a link to a public page that works with no account, no
install, and no interstitial, and that lets them answer Going / Maybe / Decline and put the
plan into Google Calendar or Apple Calendar in three taps. A plan with no date yet asks the
same people a different question — Interested / Maybe / Pass, with the date still being
decided — and any participant can propose a date for it while only the owner decides. Each
person's reminders are their own: one schedule, many reminder sets, and nobody inherits
anybody else's. Every change to a shared plan
writes to that plan's updates feed and notifies the people who need to know. Amazon SES is
out of the sandbox on a domain that passes DKIM, SPF and DMARC, so guest invitations
actually arrive. A guest who later signs up with the same verified email finds their plans
already in the app rather than a second copy of them.

**Lists become the second shareable object**, using the same People layer, the same picker
and the same authorisation shape. Two people tick through one grocery list from two shops
without a conflict, because checking is set rather than toggled and items sort by
`(rank, itemId)`. A member can do everything to items and nothing destructive to the list. A
person with no account gets an email and finds the list waiting when they sign up. Any member
may use **Plan this item**, but first chooses a visible `PlanType` and then **Just me** or
**Choose people**. List membership never becomes Plan participation. Each viewer sees only
their own `LNK#<viewerUserId>#<itemId>` pointer, so two members can create different private
Plans from the same shared item without exposing either one. And when a date finally lands on
a plan people had only agreed to in principle, everybody is asked again, because a response
to an idea is not consent to a Saturday.

## Prerequisites

| # | Requirement | Source |
| --- | --- | --- |
| 1 | Phases 0–5 complete; v1 private beta is on TestFlight | Phase 5 |
| 2 | `Activity`, `ActivityIndex`, `Person`, `Participant`, `Invite` types exist in `packages/shared/src/types/` | [`../02-architecture/data-model.md`](../02-architecture/data-model.md) §4 |
| 3 | `assertActivityAccess(userId, activityId, level)` exists in `services/api/src/services/authz.ts` | [`../02-architecture/tech-stack.md`](../02-architecture/tech-stack.md) §4.2 |
| 4 | Push registration (`POST /v1/me/devices`), the notification inbox, and the reminder Lambda ship and work | [`../01-product/notifications.md`](../01-product/notifications.md) |
| 5 | The web build exports statically and CloudFront serves it with the SPA fallback | [`../02-architecture/infrastructure.md`](../02-architecture/infrastructure.md) §4.1 |
| 6 | `ordinarydays.app` is registered, the hosted zone exists, and both ACM certificates validate | P5-01 |
| 7 | The rate-limit middleware and its `RATE#` counter item work for authenticated routes | [`../02-architecture/security-privacy.md`](../02-architecture/security-privacy.md) §5 |
| 8 | `docs/generated/openapi.json` is generated and CI fails on staleness | [`../02-architecture/api-contract.md`](../02-architecture/api-contract.md) §6 |
| 9 | Lists are stored with the canonical row at `LIST#<l>` / `META` and pointers for the owner and each active non-owner at `USER#<u>` / `LIST#<l>`; invited people have no pointer | Phase 3 P3-04. If the list still lives in the owner's partition, stop and fix that first — every shared-list task here assumes the inversion. |
| 10 | `deriveGsi1Bucket` (P2-05), `lastActivityAt` (P2-06) and `GET /v1/plans` (P3-20) all merged | The RSVP reset moves a plan between `#P` and `#S`, and the needs-a-date row is where an undated shared plan is seen at all. |
| 11 | [`../01-product/plans-and-lists.md#511-shared-lists`](../01-product/plans-and-lists.md#511-shared-lists) read in full | The behaviour: two roles and what each can do, app users only, the 20-person total cap including the owner and pending invitations, the share sheet, the invited-without-an-account path, leaving and being removed, and what two people using one list at once must see. |
| 11a | [`../02-architecture/data-model.md#shared-lists`](../02-architecture/data-model.md#shared-lists) and [`#71-rsvp-consent-does-not-survive-a-date-change`](../02-architecture/data-model.md#71-rsvp-consent-does-not-survive-a-date-change) read in full | The storage: the `ListMember` and `ListIndex` shapes, the three concurrency rules and no `If-Match` on items; and the four RSVP transitions with the labels that change while the stored values do not. |
| 11b | [`../02-architecture/data-model.md#43a-datesuggestion`](../02-architecture/data-model.md#43a-datesuggestion) §4.3a and [`../02-architecture/api-contract.md#24b-date-suggestions`](../02-architecture/api-contract.md#24b-date-suggestions) §2.4b read in full | Date suggestions are new work in this phase (P6-48 to P6-52). Any participant proposes, the cap is 5, `worksFor` is availability and not a vote, only the owner schedules, and the suggestions are deleted once a date lands. |
| 11c | Per-user reminders (P2-16) are merged, and `Activity` has no `reminders[]` | P6-13 writes a joiner's own `REM#` row from their own explicitly saved default. No capture or source-word path may create it. If reminders are still an array on the activity, stop and fix that first — every reminder line in this phase assumes the per-user items. |
| 11d | `CreationTarget`, `PlanType`, required list `templateKey`, `ScheduleListItemInput`, and `ListItemActivityLink` are merged | Phases 1 and 3. Stop if an Activity can be created without an explicit Task/Plan target, if a new list can be created without a user-selected template, or if `ListItem` still carries a global `linkedActivityId`. Shared-list work assumes the canonical contracts in `api-contract.md` §§2.3 and 2.7. |

Two canonical-document amendments this phase depends on are already recorded in
[`../02-architecture/data-model.md`](../02-architecture/data-model.md):

- `GUESTEMAIL#<lowercased-email>` / `OWNER#<ownerId>#PERSON#<personId>` in §3.4, with
  access pattern 14b (OQ-9 in
  [`../02-architecture/decisions.md`](../02-architecture/decisions.md)). Without it, guest
  → account linking needs a `Scan`, which is banned.
- `Activity.icsSequence: number` in §4.1 (task P6-08). It is additive and needs no
  backfill; the repository defaults it to `0` on read.
- `LIST#<listId>` / `LNK#<viewerUserId>#<itemId>` in §3.3, with access patterns 8b and 8c.
  A list response filters these rows to the authenticated viewer before any Activity lookup;
  there is no list-item-wide Activity id for a client to hide.
- `USER#<userId>` / `LLINK#<personId>#<addedAt>#<listId>` in §3.2, with access pattern 9a.
  Active reciprocal links power the People summary and Person view; invited owner-side links
  power signup and lifecycle checks. They are never list access grants.

## Deliverables

- [ ] A participant picker sheet that adds an existing contact, a typed guest, or a guest by
      email, enforces the 50-participant cap inline, and works on both platforms.
- [ ] `⊕ Choose from Contacts` on iOS: the OS contact picker via `expo-contacts`, returning
      one contact, storing it as an ordinary `Person`, reading no address book, requesting no
      contacts permission. A picked contact that matches an existing `Person` offers the
      existing one and never duplicates silently. The row is absent on web.
- [ ] `POST`/`PATCH`/`DELETE /v1/activities/:id/participants*` implemented with the
      transaction budget in §Tasks P6-12 respected.
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
- [ ] Guest invitation, plan-changed, plan-cancelled and list-invitation emails, and nothing
      else. `invitation` and `plan-changed` render in an undated and a dated form, and a
      non-declined guest is reset and re-emailed when a date lands; a declined guest is
      neither (P6-15).
- [ ] The plan updates feed with system entries for RSVP, schedule, rename, cancel, and
      participant changes.
- [ ] `plan_changed`, `plan_renamed`, `plan_cancelled`, `rsvp_changed`, `rsvp_guest`,
      `plan_update_posted`, `participant_left`, `invitation_reminder` delivered per
      [`../01-product/notifications.md`](../01-product/notifications.md) §7.
- [ ] Guest → registered-user linking on sign-up with a verified email, driven by a
      `GUESTEMAIL#` lookup partition, converting both plan participations and pending list
      memberships.
- [ ] Shared lists end to end: the `ListMember` entity with `reciprocalPersonId`, reciprocal
      owner-scoped People and `LLINK#` projections, index-entry fan-out on add and remove, the
      two roles enforced in the authorisation middleware, the share sheet, the MEMBERS
      section, the leave flow, and a departed member's items left exactly where they are.
- [ ] `Plan this item` on a shared list: a required user-selected `PlanType`, a required
      **Just me / Choose people** audience choice, no automatic participant selection, and
      caller-filtered per-viewer `LNK#` pointers with no global `linkedActivityId`.
- [ ] Inviting someone with no account: a fourth SES template, a `status: 'invited'` member
      row and owner-side invited `LLINK#` with **no recipient index entry**, and reciprocal
      activation on signup through the existing `GUESTEMAIL#` machinery.
- [ ] The 20-person total cap, including the owner and pending invitations, enforced
      server-side, with over-cap selections refused inline in the sheet.
- [ ] RSVP reset on a date change: every `PART#` row rewritten, a system update, one
      notification per person, and `rsvpReset: true` on the response.
- [ ] The RSVP label switch driven by whether a date exists, with **no new enum value**,
      applied on every surface including the guest page and the guest emails.
- [ ] Date suggestions end to end: `SUGG#` rows capped at 5, four endpoints, `worksFor` as an
      availability signal, owner-only `schedule { fromSuggestionId }`, suggestions deleted on
      scheduling, and the plan-detail and Needs-a-date UI. Guests cannot suggest.
- [ ] A joiner's own `REM#` row created only from their **own explicitly set**
      `defaultReminderOffset` when they are added to a shared plan (`0` is valid; unset is
      Off), with nobody inheriting anybody else's.
- [ ] A shared plan **suggesting**, never performing, sharing of the lists it generates.
- [ ] Success criterion S4 (guest RSVP in under 30 s, three taps) and S8 (the public
      projection leaks nothing) verified in CI.

## Tasks

| ID | Title | Area | Depends on | Parallel-safe | Size |
| --- | --- | --- | --- | --- | --- |
| P6-01 | SES domain identity, DKIM, MAIL FROM, SPF, DMARC in CDK | infra | — | yes | M |
| P6-02 | SES production-access request and quota | infra | P6-01 | yes | S |
| P6-03 | SES configuration set, event destination, bounce and complaint alarms | infra | P6-01 | yes | S |
| P6-04 | Email sending service and the four templates | api | P6-01, P6-03 | no | M |
| P6-05 | Public route surface: routing, caching, CORS, CloudFront behaviour | infra/api | — | yes | M |
| P6-06 | Public rate limiting: per IP and per token | api | P6-05 | no | M |
| P6-07 | Invite token generation and encoding | shared | — | yes | S |
| P6-08 | `.ics` builder | shared | — | yes | L |
| P6-09 | Google Calendar template URL builder | shared | — | yes | S |
| P6-10 | Schemas for participants, invites, updates and the public projection | shared | — | yes | M |
| P6-11 | Non-owner `ListMember`, shared-item audience schemas, the two access roles and the 20-person cap | shared | P3-01 | yes | M |
| P6-12 | Participant repository and the transaction budget | api | P6-10 | no | L |
| P6-13 | `POST /v1/activities/:id/participants` | api | P6-12, P6-07 | no | L |
| P6-14 | `PATCH /v1/activities/:id/participants/:personId` — RSVP | api | P6-12 | no | M |
| P6-15 | RSVP reset on a date change | api | P6-12, P6-14 | no | L |
| P6-16 | `DELETE /v1/activities/:id/participants/:personId` — remove and leave | api | P6-12 | no | M |
| P6-17 | Shareable invites: `POST`/`DELETE /v1/activities/:id/invites` | api | P6-07, P6-12 | no | M |
| P6-18 | The public invite projection and `GET /public/v1/invites/:token` | api | P6-10, P6-05 | no | L |
| P6-19 | `POST /public/v1/invites/:token/rsvp` | api | P6-18, P6-06 | no | M |
| P6-20 | `.ics` endpoints, public and authenticated | api | P6-08, P6-18 | no | M |
| P6-21 | Google Calendar redirect endpoint | api | P6-09, P6-18 | no | S |
| P6-22 | Updates feed: read, write, and server-side system entries | api | P6-10 | no | M |
| P6-23 | Change detection and plan-change notifications | api | P6-22, P6-04 | no | L |
| P6-24 | Invitation and RSVP notifications, inbox entries, invitation reminder | api | P6-13, P6-14 | no | M |
| P6-25 | Invite lifetime: expiry, revocation, TTL, rotation | api | P6-17 | no | M |
| P6-26 | Participant-aware fan-out: reschedule and the delete cascade job | api | P6-12 | no | L |
| P6-27 | Guest → account linking and the `GUESTEMAIL#` partition | api | P6-13 | no | L |
| P6-28 | Authorisation matrix enforcement and its test walk | api | P6-13, P6-14 | no | M |
| P6-29 | List membership repository, index fan-out and per-viewer Activity links | api | P6-11, P3-04 | no | L |
| P6-30 | `POST /v1/lists/:id/members` and the invited-without-an-account path | api | P6-29, P6-04 | no | L |
| P6-31 | `DELETE /v1/lists/:id/members/:personId` — remove and leave | api | P6-29 | no | M |
| P6-32 | List authorisation: the two roles in the middleware | api | P6-29 | no | M |
| P6-33 | Minimal People read surface for the picker | api | P6-12 | no | M |
| P6-34 | The participant picker sheet | mobile | P6-33, P6-13 | no | L |
| P6-35 | `expo-contacts` OS contact-picker integration | mobile | P6-34 | no | M |
| P6-36 | Duplicate-person match on a picked contact | mobile | P6-35, P6-33 | no | M |
| P6-37 | Web fallback: manual entry, no picker | mobile/web | P6-35 | yes | S |
| P6-38 | Plan detail: PEOPLE section, share sheet, invite-link affordances | mobile | P6-13, P6-17 | no | M |
| P6-39 | RSVP affordances on agenda rows and in the inbox | mobile | P6-14, P6-24 | no | M |
| P6-40 | The RSVP label switch: dated and undated vocabulary | shared/mobile | P6-39, P3-35 | no | M |
| P6-41 | Updates feed UI | mobile | P6-22 | yes | M |
| P6-42 | Add-to-calendar affordance on plan detail | mobile | P6-20, P6-21 | yes | S |
| P6-43 | List share, shared-item audience, MEMBERS and leave flows | mobile | P6-30, P6-31, P3-27 | no | L |
| P6-44 | A shared plan suggests sharing its generated lists | mobile | P6-43, P3-38 | no | M |
| P6-45 | The public invite page | web | P6-18, P6-19, P6-20 | no | L |
| P6-46 | E2E and projection-leak tests, S4 and S8 | ci | P6-45 | no | M |
| P6-47 | Shared-list E2E, concurrency and access tests | ci | P6-43, P6-32 | no | M |
| P6-48 | `DateSuggestion` schema, repository and the 5-per-activity cap | shared/api | P6-10 | yes | M |
| P6-49 | Suggestion endpoints: list, create, delete, `works` toggle | api | P6-48, P6-28 | no | M |
| P6-50 | `schedule { fromSuggestionId }` and suggestion cleanup | api | P6-49, P6-15 | no | M |
| P6-51 | Date suggestions on plan detail and the Needs-a-date row | mobile | P6-49, P3-35, P3-36 | no | L |
| P6-52 | Date-suggestion tests: authorisation, cap, cleanup, guest refusal | ci | P6-50, P6-51 | no | M |

---

### P6-01 — SES domain identity, DKIM, MAIL FROM, SPF, DMARC in CDK

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

### P6-02 — SES production-access request and quota

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
| What you send | Four messages: an invitation to one plan, a notice that the plan's date/time/location changed, a notice that it was cancelled, and an invitation to a shared list sent to an address the inviting user typed in. Nothing else. |
| Expected volume | Under 100/day at launch; the participant cap is 50 per plan and the API rate limit bounds the rest. |
| How bounces and complaints are handled | The account-level suppression list is on. A configuration set publishes bounce, complaint, delivery and reject events to CloudWatch; alarms fire to the operator at a 5% bounce rate and a 0.1% complaint rate. A hard bounce marks the `Person.email` invalid and the app stops sending to it and tells the owner the address did not work. |
| How recipients unsubscribe | Every guest email carries a one-click link that revokes that guest's invite token, which stops every future send about that plan. There is no list to unsubscribe from because there is no list. |

**Edge cases.**

- The default production sending quota (50,000 messages/day, 14 per second) is far beyond
  what this app needs; do not request an increase, it invites more scrutiny.
- If the request is rejected, the rejection names a missing element. Fix it in
  `ses-use-case.txt` and resubmit; do not open a second case.
- **Budget several days.** Nothing downstream in this phase can be verified end to end
  against a real recipient until this lands. Order the phase so P6-01/02/03 start on day one
  and the rest proceeds against the dev sandbox with a verified recipient.

**Tests.** A smoke script `scripts/ses-check.mjs` asserts
`GetAccountResponse.ProductionAccessEnabled === true` for prod and prints the identity's DKIM
and MAIL FROM status. It runs in the prod deploy workflow and fails the deploy if production
access has been revoked.

---

### P6-03 — SES configuration set, event destination, bounce and complaint alarms

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

### P6-04 — Email sending service and the four templates

**What to build.** One service with exactly four send functions, and no fifth.

**Files.**

- `services/api/src/services/email.ts`
- `services/api/src/email/templates/invitation.ts`, `plan-changed.ts`, `plan-cancelled.ts`,
  `list-invitation.ts` (P6-30)
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

**The four sends**, and nothing else:

| Template | To | When | Opt-out |
| --- | --- | --- | --- |
| `invitation` | A guest with an email | Added to a plan | The plan's token `stop` link |
| `plan-changed` | Guests on a plan | Date, time or location changed | Same |
| `plan-cancelled` | Guests on a plan | The plan was cancelled | Same |
| `list-invitation` | An address with no account | Added to a shared list (P6-30) | Removing them from the list, which is the only thing this address is used for |

**`invitation` and `plan-changed` render two ways, on whether the plan has a date.** This is
the same date-sensitive vocabulary the app and the public page use
([`../02-architecture/api-contract.md#210-public-unauthenticated-invite-surface`](../02-architecture/api-contract.md#210-public-unauthenticated-invite-surface)
§2.10), carried into email so a guest never meets two different questions about one plan:

| | Undated plan | Dated plan |
| --- | --- | --- |
| Subject | `Ujjwal wants to plan something with you` | `Ujjwal invited you to Dinner at Zahav` |
| The when line | `The date is being decided.` | `Saturday 15 August, 7:30 PM` |
| The three buttons | `Interested` · `Maybe` · `Pass` | `Going` · `Maybe` · `Decline` |

The three buttons deep-link to the public page rather than answering from the mail client;
there is no email-based RSVP reply channel, ever. The stored values behind the six words are
the same four
([`../02-architecture/data-model.md#71-rsvp-consent-does-not-survive-a-date-change`](../02-architecture/data-model.md#71-rsvp-consent-does-not-survive-a-date-change)),
and `interested` is not one of them.

**A date landing sends `plan-changed` in its dated form to every guest**, because a guest's
RSVP was reset with everybody else's (P6-15). That is the one send where the two renderings
matter most: the recipient answered one question and is being asked a different one, so the
body says the date has been set and that they have been asked again. Asking "are you coming?"
about a plan with no date is incoherent, and a guest is exactly the person least equipped to
work out what it means.

The first three end with the same two lines:

```
You're getting this because <Owner display name> invited you to this plan.
Stop getting emails about this plan: https://ordinarydays.app/invite/<token>/stop
```

`GET /public/v1/invites/:token/stop` revokes the token, returns a plain confirmation page,
and is rate-limited like the rest of the public surface. It is the entire unsubscribe
mechanism for plans, which is correct because there is no list.

`list-invitation` has **no token**, because a list has no public surface and nothing a
stranger can be shown. It is a one-shot message — who invited them, the list's title, and a
link to the App Store — sent once per membership, never repeated except by an explicit
`Resend`, and it carries **no item titles and no list content**. Its final line is
`You're getting this because <name> added you to a list in Ordinary Days. If that wasn't
meant for you, ignore this and nothing else will be sent.` That is the truthful unsubscribe:
there is no second message to stop.

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
- Guest emails are only ever sent for the four cases in the table above. A pull request that
  adds a fifth send function needs an explicit product decision, and the test in
  §Acceptance criteria 21 fails without one.
- **`list-invitation` is already a canonical product row.**
  [`../01-product/notifications.md`](../01-product/notifications.md) §6.3 lists all four
  sends, including `list_invitation_email`, and
  [`../02-architecture/api-contract.md#27-lists`](../02-architecture/api-contract.md#27-lists)
  requires it. Do not drop the send to get back to three; the invited member would then never
  learn they had been invited.
- The SES use-case description (P6-02) is written for four messages. Make sure
  `docs/05-operations/ses-use-case.txt` says four **before** submitting, not after — a
  production-access description that does not match what the account sends is the kind of
  discrepancy a reviewer notices.

**Tests.** `aws-sdk-client-mock` on `SESv2Client`: asserts the configuration set, the from
address, the presence of both MIME parts, the opt-out line, and that no other address ever
appears in `Destination`. A template snapshot test per template. A test that asserts exactly
four exported send functions. A test that `list-invitation`'s rendered body contains no item
title from a fixture list of ten items, and no token.

Plus **two snapshots each** for `invitation` and `plan-changed`, one against an undated
fixture and one against a dated one, asserting that the undated body contains
`The date is being decided` and the words `Interested`, `Maybe` and `Pass` and **not** the
word `Going`; and the dated body the reverse. A test that the string `interested`, lowercased,
appears in no stored value written by any of these paths — the words live in the templates and
the enum has four members.

---

### P6-05 — Public route surface: routing, caching, CORS, CloudFront behaviour

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

### P6-06 — Public rate limiting: per IP and per token

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

### P6-07 — Invite token generation and encoding

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

### P6-08 — `.ics` builder

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
  P6-23 uses to decide whether to send `plan_changed`.

**Edge cases.** An activity with no `schedule.date` has no exportable event: both `.ics`
endpoints return `409 conflict` with `This plan has no date yet.` A title containing only
whitespace falls back to `Plan`. A `DESCRIPTION` longer than 8,000 characters is truncated at
a word boundary before escaping.

**Tests.**

- Golden-file tests for: timed with end, timed without end, all-day,
  cancelled, a title containing `,` `;` `\` and a newline, a 300-character summary that must
  fold, and a summary containing emoji and CJK characters that must fold on an octet boundary
  without splitting a code point.
- **There is no multi-day golden file, and there must not be one.** `schedule` has a `date`
  and no `endDate` in v1 (ADR-050), so a multi-day `VEVENT` is not a shape this builder can be
  handed. An all-day event's `DTEND` is always the day after `DTSTART` — the exclusive
  single-day end — and a test asserts exactly that, so a range cannot be smuggled in through
  the export.
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

### P6-09 — Google Calendar template URL builder

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

**Tests.** Golden URLs for timed, all-day and no-end-time cases — and no multi-day case,
because a plan has one date (ADR-050); the all-day URL's exclusive end is always the following
day, asserted directly. A test asserting every value is percent-encoded, including `&`, `#`,
`+` and a newline in the title. A test asserting the host cannot be changed by any input.

---

### P6-10 — Schemas for participants, invites, updates and the public projection

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

### P6-11 — Non-owner `ListMember`, shared-item audience schemas, roles and the 20-person cap

**Files.** `packages/shared/src/types/list.ts` (extend),
`packages/shared/src/schemas/{list,listMember}.ts`,
`packages/shared/src/constants.ts` (add `MAX_LIST_MEMBERS = 20`).

**What to build.** The shapes for the second shareable object in the product, transcribed
from
[`../02-architecture/data-model.md#46-list-and-listitem`](../02-architecture/data-model.md#46-list-and-listitem)
— `ListMember`, `PersonListLink`, the `ListIndex` pointer Phase 3 already writes for the
owner, and the shared-list branch of the existing `ScheduleListItemInput`. The stored
`ListItemActivityLink` remains the Phase 3 shape
`LIST#<listId>` / `LNK#<viewerUserId>#<itemId>`; sharing adds viewers, not a second link model.

**The two access roles**, from the same section and from
[`../02-architecture/api-contract.md#3-authorisation-rules`](../02-architecture/api-contract.md#3-authorisation-rules):

| Role | Can |
| --- | --- |
| `owner` | Everything: delete the list, add and remove members, change `behaviour`, `capabilities` and `slot` |
| `member` | Add, edit, check, reorder and delete **items**; rename the list; leave it |
| `member` cannot | Change `behaviour` or `capabilities` — those are destructive under the interaction contract — delete the list, or remove anyone but themselves |

Two roles, not three. They live on `ListIndex`: the owner's pointer is `owner`, and every
active non-owner's pointer is `member`. A read-only viewer is a deferred open decision
([`../00-open-decisions.md`](../00-open-decisions.md)), not an omission, and adding one here
would mean a third branch in every item route for a case nobody has asked for.

**The cap is 20 people total, including the owner and pending invitations**, deliberately
below the 50 for a plan. A shared list is a household feature, not a broadcast one, and the
number is low enough that the roster remains unpaginated. It lives in `constants.ts` and is
imported by the client and the server — two
copies of `20` is the bug this file exists to prevent.

**Approach.**

- `status` is `'invited' | 'active'`. `userId` and `reciprocalPersonId` are **absent** while
  status is `'invited'`; both are required for an active non-owner member. A schema
  refinement enforces every combination. `reciprocalPersonId` identifies the member-owned
  Person for the list owner so removal can delete the member-side `LLINK#` by exact key.
- `addedAt` is immutable and identical on the `ListMember`, `ListIndex` and both reciprocal
  `LLINK#` keys. Activation preserves it, so removal can construct both exact keys without a
  scan; `joinedAt` records the later verified-signup moment separately.
- The owner has **no** `ListMember` row. `List.ownerId` and the Phase 3 owner pointer are the
  ownership records; `GET .../members` synthesises the owner's first roster row from them and
  the owner's profile. Every physical `MEMBER#` row has fixed `role: 'member'`, and its active
  `ListIndex` pointer carries the same role for one-read authorisation (P6-32). A private list
  therefore has zero `MEMBER#` rows and `memberCount: 1`; in every state, `memberCount` is one
  plus the number of physical member rows.
- Request bodies are `.strict()`. `POST .../members` is `{ personId }` or `{ displayName,
  email }` and nothing else: `role`, `status`, `userId`, `reciprocalPersonId`, `joinedAt` and
  `invitedBy` are all server-derived.
- `PersonListLink` is `{ personId, listId, addedAt, status }` at
  `USER#<userId>` / `LLINK#<personId>#<addedAt>#<listId>`. It carries no title or count, and
  the request schemas accept no link fields. Active links count for People; invited links do
  not. Neither is accepted by `assertListAccess`.
- `ScheduleListItemInput` remains a strict discriminated contract:

  ```ts
  {
    creationTarget: { objectKind: 'plan'; type: PlanType };
    audience:
      | { mode: 'just_me' }
      | { mode: 'selected_people'; participants: ParticipantInput[] };
    // compatible Plan fields only
  }
  ```

  `selected_people.participants` is non-empty. Missing `creationTarget`, missing `audience`,
  `type: 'task'`, participants on `just_me`, and unknown keys are validation failures. The
  list's title, item words, `templateKey`, `behaviour`, capabilities, and membership are never
  inputs to Plan-type or audience selection.
- No create or patch schema for `ListItem` contains `linkedActivityId`. Link fields are
  server-written `ListItemActivityLink` rows; a request carrying `viewerUserId`, `activityId`,
  or `linkedAt` is rejected.

**Tests.** Schema: every `ListMember.role` is the literal `member`, and `owner` is rejected;
active non-owner membership without either `userId` or
`reciprocalPersonId` is rejected; invited membership with either is rejected; a body carrying
`role`, `status` or `reciprocalPersonId` is rejected; `MAX_LIST_MEMBERS` is
imported, not literal, in every file that enforces it — asserted by a grep test for a bare
`20` in the list membership paths. A type-level test that a `Record<ListRole, …>` map with a
missing key fails to compile. Table-test every `ScheduleListItemInput` union branch and each
invalid combination above. A compile-time and schema test rejects `linkedActivityId` on a
ListItem, and a repository shape test fixes the `ListItemActivityLink` attributes to exactly
`listId`, `itemId`, `viewerUserId`, `activityId`, and `linkedAt`.

---

### P6-12 — Participant repository and the transaction budget

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
| Add participant, app user | `ACT#/PART#`, `USER#<invitee>/IDX#`, `USER#<owner>/PLINK#`, `USER#<invitee>/PLINK#`, `USER#<invitee>/PERSON#` (reciprocal contact), `ACT#/META` counter, plus an optional matching `LIST#/LNK#<invitee>#<item>` when this Plan has list provenance and the invitee is an active member there | 7 max | Yes |
| Add participant, guest with email | `ACT#/PART#`, `USER#<owner>/PERSON#`, `USER#<owner>/PLINK#`, `INVITE#<token>/META`, `GUESTEMAIL#<email>/OWNER#<ownerId>#PERSON#<id>`, `ACT#/META` counter | 6 | Yes |
| Add participant, guest without email | `ACT#/PART#`, `USER#<owner>/PERSON#`, `USER#<owner>/PLINK#`, `ACT#/META` counter | 4 | Yes |
| Create Plan with `participants[]` | 2 base (`ACT#/META`, owner `IDX#`) + up to 7 per participant | 352 | **No** — see below |
| Reschedule | `ACT#/META` + one `IDX#` per participating **app user**, owner included | 52 | Yes |
| Remove participant | `ACT#/PART#` delete, their `IDX#` delete, both `PLINK#` deletes, `INVITE#` revoke, `ACT#/META` counter, plus conditional delete of their matching `LNK#` when present | 7 max | Yes |
| Delete activity | Every item in the `ACT#` partition + every participant's `IDX#` + both directions of every `PLINK#` + only per-viewer `LNK#` rows that still point to this Activity | 200+ | **No** — see P6-26 |

> **Decision — creation fans out in batches, not in one transaction.** `POST /v1/activities`
> writes `ACT#/META` and the owner's `IDX#` in a two-item transaction and returns as soon as
> that succeeds. `participants[]` is then applied in further transactions of **at most eight
> participants each** (≤ 56 items, plus one `META` counter action per transaction, which is
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

One further write path lives in this repository although its endpoint is Phase 7's
(`POST /v1/people/:id/merge`, P7-21): **Person merge collapses duplicate `Participant` rows
on the same activity.** When both People are participants of one activity, the survivor
keeps exactly one `PART#` row — the one with the **latest `respondedAt`** wins —
the duplicate is deleted, `ACT#/META.participantCount` is decremented, the RSVP counts are
recounted from the remaining rows, and any expense splits and date suggestions keyed by the
losing `personId` are re-pointed at the survivor, all in one transaction per activity. This
is the repair path for the accepted duplicate-guest risk (risk 14).

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

### P6-13 — `POST /v1/activities/:id/participants`

**What to build.** The one endpoint that turns a private Plan into a shared Plan. Tasks never
accept direct participants; coordinated work starts as an explicitly chosen Plan kind.

**Files.** `services/api/src/routes/participants.ts`,
`services/api/src/handlers/participants.ts`,
`services/api/src/services/participants.ts`.

**Approach.** Body is either `{ personId }` or `{ displayName, email? }`. The service:

1. `assertActivityAccess(userId, activityId, 'owner')`, then asserts
   `activity.objectKind === 'plan'`. A Task returns `400 validation_failed`; adding a person
   never promotes it or chooses a `PlanType`.
2. Enforces `participantCount < 50`, else `422 participant_limit_exceeded`.
3. Resolves or creates the `Person` in the **caller's** partition.
4. Decides guest vs app user: an email that matches an `EMAIL#<lowercased>` row belongs to a
   registered user, and the `Person` is created with `linkedUserId` set. An email with no
   match creates a guest and an `INVITE#` token.
5. Runs the appropriate transaction from P6-12.
6. Flips `activity.visibility` to `'shared'` if it is not already, in the same transaction.
   The flip is **one-way**; removing the last participant does not reverse it
   ([`../01-product/sharing-and-people.md`](../01-product/sharing-and-people.md) §2.1).
7. For an **app user** with a non-null/set `defaultReminderOffset`, writes **their own**
   `ACT#/REM#<theirUserId>#<reminderId>` row from **their own** profile setting, in the same
   transaction, and schedules it (P5-14). `0` is a valid At-the-time reminder; absent/null is
   Off and writes nothing.
8. Writes a system update (`Ujjwal added Alice`), notifies the added person only, and
   returns the `Participant` plus, for a guest, `inviteUrl`.

When the Plan carries `listId` and `listItemId`, adding a registered participant also checks
whether that user is an active member of the source list. If so, the same transaction writes
or replaces `LIST#<listId>` / `LNK#<theirUserId>#<itemId>` for this Plan. If not, they receive
Plan access but no list pointer. This check never runs in reverse: being a list member does
not add anyone to the Plan.

**Step 7 is where per-user reminders become visible.** A shared plan has **one schedule and
many reminder sets** (ADR-047). The joiner's reminder comes from *their* default, never from
the owner's row and never from `CreateActivityInput.reminders`, which wrote for the creator
alone (P1-11). Nobody inherits anybody else's, and nobody is opted into a push at somebody
else's chosen offset.

If the plan has no date, the row is still written and simply has nothing to schedule against
until one lands — the same rule as P2-16. A guest gets no reminder row at all: they have no
user partition, no device and no profile to take a default from.

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
- A Task refuses every participant add without changing `objectKind` or `type`.

**Tests.** Route integration tests for: owner adds a contact; owner adds a new guest by name;
owner adds a guest by an email that matches a registered user (asserts `linkedUserId` is set
and an `ActivityIndex` appears in that user's partition); participant tries to add someone
(`403`); stranger tries (`404`); the 51st add (`422`); a duplicate add (`200`, idempotent);
`visibility` flips exactly once; a Task returns `400` and is byte-identical afterwards.

For list provenance: adding an active source-list member writes their `LNK#` pointer; adding
the same person to a Plan sourced from a list they cannot access writes no `LNK#`; an
unselected member of the list remains absent from `PART#`, `IDX#`, and `LNK#` throughout.

Plus the reminder fan-in, which is the property most easily got wrong: an owner with
`defaultReminderOffset: -15` adds a participant whose own default is `-120`; the partition
then holds **two** `REM#` rows with two different `userId`s and two different offsets, the
owner's row is byte-identical to what it was before the add, and the participant's
`GET /v1/activities/:id/reminders` returns exactly one reminder at `-120`. A second case:
adding a participant whose `defaultReminderOffset` is `0` writes one At-the-time `REM#` row;
an unset/null default writes none, and adding a **guest** writes none either.

---

### P6-14 — `PATCH /v1/activities/:id/participants/:personId` — RSVP

**What to build.** The three-state RSVP, and what each state does to the invitee's Today.

**Files.** `services/api/src/services/participants.ts` (extend), plus the `ActivityIndex`
repository.

**Approach.**

| Response | Storage effect |
| --- | --- |
| `going` | `PART#.rsvp = 'going'`, `respondedAt` set. `IDX#` untouched. |
| `maybe` | Same with `'maybe'`. `IDX#` untouched. |
| `declined` | `PART#.rsvp = 'declined'` and the invitee's `USER#/IDX#` item is **rewritten as a declined, read-only entry**, in one transaction. The plan leaves their Today and agenda, but Plans keeps a durable read-only row under the plan's date with a `Rejoin` action. |

Every RSVP write also stamps `PART#.rsvpForDate` from the plan's **current** date (null when
undated), in the same transaction, so `Alice said yes to Saturday` is always provably about
the date she answered.

Re-accepting — `Rejoin` from the durable Plans row, or from the notification inbox —
restores the full `IDX#` entry with the correct GSI1 keys — so the write path must be able
to reconstruct `gsi1pk`/`gsi1sk` from the activity, which means the service reads
`ACT#/META` first rather than trusting anything on the `PART#` row. The declined inbox
entry is retained for 90 days, but the route back does not depend on it: the durable
declined row in Plans is permanent for as long as they remain a (declined) participant.

Authorisation: a participant may change only their own; the owner may change anyone's
([`../01-product/sharing-and-people.md`](../01-product/sharing-and-people.md) §3.2). A
declined participant retains RSVP-change rights and nothing else — the authz helper treats
`declined` as a participant for this route and `404`s every other route (privacy rule P7).

**Edge cases.** Changing an RSVP after the plan's date is allowed. An RSVP change always
writes a system update and notifies the owner, including when the owner is the one changing
it on someone's behalf — in which case the update reads `Ujjwal marked Alice as going`, not
`Alice is going`, because the app must not attribute a statement to someone who did not make
it.

**Tests.** Each transition; the `IDX#` rewrite to the declined read-only entry on decline
and its restoration on `Rejoin`; the declined row appears in Plans under the plan's date and
is read-only apart from `Rejoin`; rejoin still works after the 90-day inbox entry is gone;
every RSVP write stamps `rsvpForDate` with the plan's current date;
participant cannot change another's; owner can; a declined participant gets `404` from
`GET /v1/activities/:id`; the system-update wording differs for self versus owner-relayed.

---

### P6-15 — RSVP reset on a date change

**Files.** `services/api/src/services/scheduleService.ts` (extend the Phase 2 endpoint),
`services/api/src/services/participants.ts`,
`packages/shared/src/activities/rsvpReset.ts` (pure).

**What to build.** The rule in
[`../02-architecture/data-model.md#71-rsvp-consent-does-not-survive-a-date-change`](../02-architecture/data-model.md#71-rsvp-consent-does-not-survive-a-date-change),
made real on `POST /v1/activities/:id/schedule`.

**Why.** Someone who said yes to an undated plan agreed to **the idea**, not to a time nobody
had picked. Carrying that response onto a Saturday claims consent they never gave, in a
product whose whole posture is *suggest, never assume*. This is a product rule with a storage
consequence, not an implementation convenience.

**The four transitions**, decided by one pure function,
`shouldResetRsvps(before, after): boolean`, which takes the two schedules and nothing else:

| Transition | Effect on every participant's `rsvp` |
| --- | --- |
| No date → a date | **Reset to `pending`**, clear `respondedAt`, set `rsvpForDate`, system update, notify |
| Date changes, e.g. Sat → Sun | **Reset**, same as above |
| Time changes only, same date | **Kept.** Notify with the existing `plan_changed`, do not re-ask |
| Date cleared, back to undecided | **Kept**, and `rsvpForDate` cleared. Re-asking somebody to un-agree is noise |

`rsvpForDate` exists so the client can render `Alice said yes to Saturday`, and so a reset is
provably correct rather than inferred.

**The transaction.** One `TransactWriteItems` carrying:

1. `ACT#/META` — the new schedule, the bumped `icsSequence` (P6-08), `updatedAt`.
2. Every participating app user's `USER#<u>` / `IDX#` — the GSI1 bucket and sort key both
   change, per P6-26. A no-date-to-date transition also moves the bucket from `#P` to `#S`
   (P2-05).
3. **Every `ACT#/PART#` row except the owner's and any row whose `rsvp` is `declined`** —
   `rsvp: 'pending'`, `respondedAt` removed, `rsvpForDate` set to the new date. Declined
   rows — app user or guest — are left untouched: a decline survives a date change
   (decision locked 2026-08-07).
4. The system update entry.
5. A delete for **every `ACT#/SUGG#` row**, when the activity had date suggestions (P6-50).
   At most 5, and usually 0, so the budget below is unaffected in the case that binds.

At the 50-participant cap this is 1 + 51 + 50 + 1 = 103 items, which **exceeds the 100-item
transaction limit.** The budget is real and it has to be handled here rather than discovered
at 50 participants:

> **Decision — the reset is part of the same transaction up to 45 participants, and a
> two-phase write above it.** Below the threshold, one transaction: the schedule change and
> the reset either both happen or neither does, which is the property that matters, because a
> date that lands without resetting responses is exactly the consent problem this rule
> exists to prevent. Above it, phase one writes `ACT#/META` with a `rsvpResetPending` marker
> plus the index entries, and phase two rewrites the `PART#` rows in batches of 25 and clears
> the marker. **While the marker is set, every read of a participant's RSVP returns
> `pending`** — the projection reads the marker, so the intermediate state is never visible
> as a stale `going`. The threshold is a constant in `packages/shared/src/constants.ts` and
> is exercised by a test at 45 and at 46.

**The response carries `rsvpReset: true`** so the client can say so rather than letting
people discover it. The Phase 3 reschedule sheet already has the confirmation shape; this
task fills in the count, which is the number of participants who **have actually responded**,
not the number of participants. Nobody has replied means no confirmation at all
([`../01-product/plans-and-lists.md`](../01-product/plans-and-lists.md) §1.4).

**The notification.** Each participant receives one `plan_date_set` (no date → a date) or
`plan_date_changed` (date → different date), whose body says the plan has a date and that
they have been asked again. A time-only change keeps the existing `plan_changed`. The keys go
through the same `classifyChange` dispatch as every other plan change (P6-23), so a single
`PATCH` that moves a date and a location still produces **one** push per person.

**Edge cases.**

- **The owner's own row is never reset.** The owner set the date; asking them whether they
  are going to their own plan is absurd.
- A participant whose `rsvp` is already `pending` is still written, so `rsvpForDate` is
  correct for everyone. It is not a visible change for them and produces no notification.
- A `declined` participant — app user or guest — is **not re-asked**. Their `PART#` row
  keeps `rsvp: 'declined'` and `respondedAt`, they get no notification and no email, and
  their declined read-only `IDX#` entry (P6-14) is untouched apart from the date it shows.
  They said no; a date change is not an invitation. The route back is the durable declined
  row's `Rejoin` (P6-14, P6-24).
- **Guests are reset and re-emailed on exactly the same rule as app users — one rule, and
  it excludes `declined` on both sides.** A non-declined guest's `PART#` row goes back to
  `pending` and they receive the `plan-changed` email, whose copy switches
  from "the date is being decided" to the date. A guest who tapped `Interested` on a dateless
  plan has not agreed to a Saturday any more than an app user has, and the guest is the person
  least able to work out what their old answer now means. The public page they land on shows
  **Going / Maybe / Decline** rather than Interested / Maybe / Pass, because the plan now has
  a date (P6-45). There is no second, separate guest email for this — the existing template
  carries the changed vocabulary. A declined guest, like a declined app user, is neither
  reset nor re-emailed.
- A reset bumps `lastActivityAt`? **No.** The date landing is an edit by the owner, and the
  plan leaves the `#P` bucket in the same write, so there is nothing left to sort.
- An activity with no participants takes the ordinary Phase 2 path and writes no `PART#`
  rows at all.

**Tests.** `shouldResetRsvps` is table-driven over all four transitions plus: same date and
same time (no reset, no notification), a timezone-only change (no reset), and an `endTime`
change (no reset). Integration: a plan with three participants, two of whom responded, gets a
date — all three `PART#` rows read `pending`, all three carry the new `rsvpForDate`, the
owner's row is untouched, the response carries `rsvpReset: true`, one system update exists
and three notifications were dispatched. Changing only the time afterwards leaves all three
responses intact and dispatches `plan_changed`, not `plan_date_changed`. Clearing the date
keeps the responses and clears `rsvpForDate`. A 46-participant plan takes the two-phase path
and a read taken between the phases returns `pending` for everyone, never a stale `going`.
And the count assertion: a plan where nobody has responded returns `rsvpReset: false` and the
client shows no confirmation.

Plus the guest and suggestion cases: a plan with one guest who answered `going` while undated
is reset to `pending` and one `plan-changed` email is sent whose rendered body contains the
new date and **not** the phrase about the date being decided; a declined app user and a
declined guest are both untouched by the same reset — rows still `declined`, no
notification, no email; and a plan carrying three
`SUGG#` rows has none after the schedule write, asserted by counting the partition.

---

### P6-16 — `DELETE /v1/activities/:id/participants/:personId` — remove and leave

**What to build.** Two operations behind one route: the owner removing someone, and a
participant leaving.

**Approach.** Removing revokes that person's personalised invite token in the same
transaction, deletes their `IDX#`, and decrements the counter. If no retained Expense
references the relationship, delete both `PLINK#` rows; otherwise change their scope to
`finance_only`. Leaving does the same for the caller and writes a `participant_left` inbox entry for the
owner. In both operations, prep tasks the departing person owns are **detached to them**,
not deleted and not stranded on the plan: each of their own child Tasks gets
`parentActivityId` cleared (and `childCount` decremented), so it leaves the plan's PREP
section and stays on their own Today, and the system feed entry counts what moved —
`Sam left · 1 prep task went with him`. Removal is confirmed in the UI and has **no undo**
([`../01-product/interaction-contract.md`](../01-product/interaction-contract.md) §4.1);
re-adding sends a fresh invitation with a new token.

If the Plan has source-list provenance, the transaction conditionally deletes
`LIST#<listId>` / `LNK#<removedUserId>#<listItemId>` **only when its `activityId` still equals
this Plan**. A pointer that the viewer has since replaced with another Plan survives. This
removes navigation for a former Plan participant without touching the shared ListItem.

**Edge cases.** The owner cannot be removed and cannot leave; the only exit is deleting the
plan. Removing a person who has expenses on the plan is allowed and does **not** delete the
expenses — the arithmetic must still reconcile
([`../01-product/expenses.md`](../01-product/expenses.md) §4). Their name stays on the
expense rows. A finance-only `PLINK#` grants only the exact balance/expense/settlement
projection, never Plan access or People activity history; Phase 7 consumes it. This is stated
here because the obvious implementation deletes too much.

**Tests.** Owner removes; participant leaves; participant cannot remove another; the token is
`410` immediately after removal; expenses and both finance-only links survive removal and a
full balance rebuild remains identical; without Expenses both links are deleted; the owner
cannot leave. A leaver with one prep task of their own sees it detached — `parentActivityId`
cleared, gone from the plan's PREP, still on their Today — and the feed entry names the
count; another participant's prep tasks are untouched. For a
Plan sourced from a shared item, the removed participant's matching `LNK#` is deleted and the
ListItem is byte-identical; if their pointer already targets a newer Plan, it remains.

---

### P6-17 — Shareable invites

**What to build.** `POST /v1/activities/:id/invites` (no `personId`) and
`DELETE /v1/activities/:id/invites/:token`.

**Approach.** A shareable invite is an `INVITE#<token>` row with no `personId`. Whoever opens
it supplies a name at RSVP time, which creates a `Person` and a `Participant` in the owner's
partition at that moment (P6-19). Owner-only on both routes. The response is
`{ token, url, expiresAt }`.

**Edge cases.** An activity may hold at most **five** live shareable invites; rotation is
`POST` a new one then `DELETE` the old. Personalised tokens are not rotatable — remove and
re-add the person. A shareable invite on an activity with no date expires 90 days after
creation rather than 90 days after the date.

**Tests.** Create, list on the activity detail, revoke, `410` after revoke, the five-invite
cap, non-owner gets `404`.

---

### P6-18 — The public invite projection and `GET /public/v1/invites/:token`

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
| `plan.dateStatus` | `'scheduled'` or `'undecided'` | Always. Derived from `Boolean(activity.schedule?.date)`. It is what drives the page's vocabulary (P6-45), so the page never has to infer it from four nullable fields |
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
**any reminder belonging to anybody**, **any date suggestion**, or occurrence data;
`location.lat`/`location.lng` when `location.address` is absent; `sourceUrl` unless it is
`details.ticketUrl`.

The two newest denials are the two most likely to be added by accident, because both hang off
the same partition the projection already loads. A reminder is a statement about one person's
day and belongs to that person alone
([`../02-architecture/security-privacy.md`](../02-architecture/security-privacy.md) §1
row 15). A date suggestion names who proposed what, which is participant identity — the thing
this projection exists to withhold — and guests cannot suggest dates in the first place, so
there is nothing for them to read and nothing to write.

Response codes: `404` for an unknown token with a body identical to every other `404`; `410
invite_expired` past expiry; `410 invite_revoked` when revoked. Both `410`s return **no plan
data at all** — not the title, not the date.

**Edge cases.** A cancelled plan still resolves, with `plan.status: 'cancelled'`; the page
renders a cancelled banner and hides the RSVP control, because a guest reading "cancelled" is
strictly better than a guest reading `410`. Coordinates without an address are dropped
(privacy rule P10). An activity whose owner has been soft-deleted resolves with
`organiser.displayName` intact ([`../02-architecture/auth.md`](../02-architecture/auth.md)
§8).

**Tests.** The snapshot allow-list test from P6-10 runs against a fully-populated fixture — an
activity with notes, three expenses, five participants with emails, four attachments, two
lists, a recurrence, reminders for three different users, five date suggestions, and
`lat`/`lng` but no address — and asserts the serialised response matches a checked-in JSON
file byte for byte. Adding a field anywhere upstream fails this test, which is criterion S8.
Separate tests for each `410`, for the deny list applied to a cancelled plan, and for a
non-`event` type never emitting `description`.

Plus the undated case, which the fixture above does not cover: an activity with no
`schedule` returns `dateStatus: 'undecided'` with `plan.date`, `plan.time`, `plan.endTime`
and `plan.timezone` all null, and still returns its title, location and organiser. An undated
plan has a working invite page; it is not a `409`.

---

### P6-19 — `POST /public/v1/invites/:token/rsvp`

**What to build.** The three-tap path that is success criterion S4.

**Approach.**

- Personalised token: `{ response }` alone is sufficient. Updates the existing `Participant`.
- Shareable token: `{ response, displayName, email? }`. `displayName` is required; on first
  use it creates a `Person` and a `Participant` in the **owner's** partition. Repeat visits
  from the same browser are identified by a `guestKey` — an opaque value the page stores in
  `localStorage` and sends back — so a guest changing their answer updates their row rather
  than creating a second one.
- When the supplied `email` matches a **verified** `EMAIL#<lowercased>` record, the RSVP is
  attached to that existing user rather than creating a guest: the owner's `Person` is
  written with `linkedUserId` set and the responder becomes an app-user `Participant` (with
  their `IDX#` entry), exactly as if the owner had added them by that email (P6-13). No
  guest `Person` and no `GUESTEMAIL#` row are written. An email with no verified `EMAIL#`
  match, or no email at all, takes the guest path unchanged.

Every response writes a system update and notifies the owner (`rsvp_guest`). Rate limits from
P6-06 apply. `Cache-Control: no-store`.

**Edge cases.** The endpoint takes the same three stored values whether or not the plan has a
date — `going`, `maybe`, `declined` — and never an `interested`. The word the guest tapped is
a rendering decision made on the page (P6-45); the body it sends is identical in both cases,
which is why a date landing needs no data migration and only a reset. A guest may change their
answer any number of times; the page always shows
the current one. A shareable link used by 51 distinct people hits the participant cap and
returns `422` with `This plan is full.` — the only public error that says anything about the
plan's state, and it is unavoidable. `email` is optional and labelled as such; supplying it
enables plan-change emails and nothing else. The `guestKey` is never a cookie, so there is no
consent banner.

**Tests.** Playwright: open link, tap `Going`, see confirmation — asserted under three taps
and, with a throttled network profile, under 30 seconds (S4). Integration: personalised and
shareable paths; the `guestKey` de-duplication; the participant cap; the per-token rate limit;
an RSVP supplying an email with a verified `EMAIL#` match produces an app-user `Participant`
with `linkedUserId` set, an `IDX#` in that user's partition and no guest `Person`, while the
same email unregistered produces the ordinary guest row. The response must not reveal which
path was taken — the body is identical in both cases, so the endpoint never answers "does
this address have an account".

---

### P6-20 — `.ics` endpoints, public and authenticated

**What to build.** `GET /public/v1/invites/:token/ics` and `GET /v1/activities/:id/ics`.

**Approach.** Both call `buildIcs` with the fields from the same projection used by the
surface they sit on — the public endpoint uses the P6-18 projection, so it cannot export a
field the page does not show. Headers:

| Header | Value |
| --- | --- |
| `Content-Type` | `text/calendar; charset=utf-8; method=PUBLISH` |
| `Content-Disposition` | `inline; filename="<slug>.ics"` by default; `attachment; filename="<slug>.ics"` when `?download=1` |
| `Cache-Control` | `no-store` |

`inline` is what makes iOS hand the file to Calendar directly rather than downloading it;
`attachment` is the desktop `Download .ics` button. The filename slug is derived from the
title, ASCII-only, capped at 40 characters, defaulting to `plan`.

**Edge cases.** No date → `409`. A revoked or expired token → the same `410`s as P6-18, with
no calendar body. The authenticated endpoint is available to the owner and participants; a
stranger gets `404`.

**Tests.** Header assertions; the file parses under `ical.js`; the `UID` differs between the
two surfaces and is stable across two calls; `SEQUENCE` increases after a reschedule and does
not after a note edit.

---

### P6-21 — Google Calendar redirect endpoint

**What to build.** `GET /public/v1/invites/:token/calendar/google`.

**Approach.** Loads the same projection, builds the URL with P6-09, asserts the host is
`calendar.google.com`, and returns `302` with `Location` and `Cache-Control: no-store`. No
body. The authenticated equivalent is not a separate endpoint: the client builds the same URL
locally from data it already has.

**Tests.** `302` with a well-formed `Location`; `410` paths return no `Location` header at
all; a test that mutates the builder's base URL constant and asserts the handler refuses to
redirect.

---

### P6-22 — Updates feed: read, write, and server-side system entries

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
| `participant_added` | P6-13 | `Ujjwal added Alice` |
| `participant_removed` | P6-16 | `Ujjwal removed Ben` |
| `participant_left` | P6-16 | `Ben left` |
| `rsvp_set` | P6-14, P6-19 | `Alice is going` |
| `rsvp_set_by_owner` | P6-14 | `Ujjwal marked Alice as going` |
| `schedule_changed` | P6-23 | `Time changed to 8:00 PM` |
| `location_changed` | P6-23 | `Moved to Suraya` |
| `renamed` | P6-23 | `Renamed to Dinner at Suraya` |
| `cancelled` / `uncancelled` | P6-23 | `Cancelled` / `Cancellation undone` |

**Edge cases.** Participants may post; nobody may delete another's post; the author may delete
their own. The feed is capped at 500 entries per activity, after which the oldest system
entries (never user entries) are trimmed by the maintenance job. Guests never read or write
the feed.

**Tests.** Pagination; authorisation (`participant` can post, guest cannot, stranger `404`);
the writer produces a structured `params` object with no pre-rendered string; deleting
another's entry is `403`.

---

### P6-23 — Change detection and plan-change notifications

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
SES send per guest **with an email, a live token, and an `rsvp` that is not `declined`** —
the guest fan-out carries the same RSVP filter as the reset rule (P6-15): a declined guest
is not emailed about a plan they said no to. Quiet hours are applied by the existing
notification service, with the documented exception that a plan-change or date-change
notification for a plan starting less than 12 hours away is delivered immediately
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
guest with a revoked token receives nothing, and a guest whose `rsvp` is `declined`
receives nothing either.

---

### P6-24 — Invitation and RSVP notifications, inbox entries, invitation reminder

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
create inbox entries. The `held_digest` path already exists from Phase 5 and must be
exercised by the new categories. The inbox entry for a declined invitation is retained for
**90 days**, but it is a convenience, not the route back: rejoining a declined plan goes
through the durable read-only row in Plans (P6-14) and works whether or not the inbox entry
still exists.

**Tests.** Each catalogue entry produces the right push/inbox combination; the invitation
reminder is cancelled on every one of the four cancelling events; a user who declined and then
re-accepts — from the inbox while its entry lives, or from the durable Plans row after the
90-day entry is gone — regains the plan on Today.

---

### P6-25 — Invite lifetime: expiry, revocation, TTL, rotation

**What to build.** The lifecycle table in
[`../01-product/sharing-and-people.md`](../01-product/sharing-and-people.md) §4.6, made real.

**Approach.**

- `expiresAt` = plan date + 90 days, or creation + 90 days when unscheduled.
- `ttl` = `expiresAt` + 30 days, so DynamoDB removes the row for free and the token then
  resolves `404` instead of `410`.
- Rescheduling **recomputes** `expiresAt` and does not revoke.
- **Setting a date on a plan whose guest tokens have expired or been TTL-deleted reissues
  them.** The schedule write mints a fresh `INVITE#` token per affected guest and the
  date-change email (P6-15, P6-23) carries the new link — excluding declined guests, per
  the same RSVP filter as every other guest fan-out. When reissue is not possible (for
  example the guest opted out, which is a revocation, not an expiry), the owner's
  participant row shows `Invite expired — resend` instead of silently emailing nothing.
- Removing a participant, deleting the plan, or hitting the opt-out link sets `revoked: true`.
- A guest who follows a token belonging to a **deleted** plan gets a minimal
  `This plan was removed` page — not a blank `410` body — with no plan data on it.
- Expiry is evaluated in the handler against the current time, never by relying on TTL —
  TTL deletion is best-effort within 48 hours and must never be a security control.

**Tests.** Expired, revoked, unknown and live tokens each produce the right status and body; a
reschedule extends `expiresAt` and leaves `revoked` false; setting a date on a plan with one
expired and one TTL-deleted guest token reissues both and the two re-emails carry working
links, while a declined guest gets neither a token nor an email; an opted-out guest is not
reissued and the owner's row reads `Invite expired — resend`; a token for a deleted plan
renders the `This plan was removed` page with no plan fields in the response; deleting a
plan revokes every one of its tokens including shareable ones.

---

### P6-26 — Participant-aware fan-out: reschedule and the delete cascade job

**What to build.** The two multi-item writes that grow with the participant list.

**Approach.**

**Reschedule.** One transaction: `ACT#/META` plus one `IDX#` per participating app user
(GSI1 sort keys change with the date). At the 50-participant cap this is 52 items, inside the
100 limit. Guests have no `IDX#`, so they cost nothing here.

A reschedule that changes the **date** also rewrites every `PART#` row (P6-15), which takes
the same transaction past the limit at the cap. P6-15 owns that budget and its threshold;
this task owns the index fan-out and must leave room for it. The two land together, and the
bucket may also change — `#P` to `#S` when a date first arrives, `#S` to `#P` when one is
cleared — which `deriveGsi1Bucket` decides and this fan-out applies to every participant's
entry, not only the owner's.

**Delete.** A shared plan with participants is **cancelled before it is deleted** — there is
no delete-with-participants path that skips the cancel. The delete flow first sets
`status → cancelled`, which dispatches the ordinary `plan_cancelled` notifications through
P6-23 so every participant learns the plan is off before its rows disappear; only then does
the two-phase deletion below run. A plan with no participants deletes directly, as in
Phase 3. The delete confirmation shown to the owner also names what goes with the plan —
the expense count, the totals, and any unsettled amounts (`3 expenses · $412.00 · $121.50
still unsettled`) — so nobody deletes a ledger they thought was a dinner.

Before either phase, query the Activity's Expenses. If any
`settlementIdByPersonId` map is non-empty, return `409 settlement_conflict` with every
distinct blocking id and write no tombstone; explicit Undo is the only way forward. When the
guard is clear, deletion cannot be one transaction and uses two phases:

1. **Tombstone**, transactional, two items: set `ACT#/META.deletedAt` and delete the owner's
   `IDX#`. From this instant the plan is gone from every read path, because every read either
   goes through GSI1 or checks `deletedAt`.
2. **Cascade**, a resumable job keyed by a `USER#<owner>/DELJOB#<activityId>` item. It pages
   the `ACT#` partition and issues `BatchWriteItem` calls of 25, deleting participants,
   expenses and each Expense's global locator, updates, occurrences and attachments, then
   deletes each participant's `IDX#` and
   both directions of every `PLINK#`, revokes every `INVITE#`, and, when the Activity carries
   `listId` / `listItemId` provenance, conditionally deletes the owner and participant
   `LNK#<viewerUserId>#<itemId>` rows that **still point to this Activity**. It never updates
   the `ListItem`: there is no global `linkedActivityId` to clear. It records progress on the
   job item and is safe to run twice.

`BatchWriteItem` has no condition expression, so those bounded `LNK#` removals use individual
`DeleteItem` calls with `activityId = :deletedId`; a conditional failure means the viewer has
already replaced the pointer and is success, not an error.

The cascade runs inline for small plans (fewer than 60 items total, which is the common case)
and is handed to the maintenance job when it is larger, so a delete never times out a 15-second
Lambda.

**Edge cases.** S3 attachment objects are deleted in the cascade; a failure there is logged and
retried by the maintenance job rather than blocking the row deletes. A `DELJOB#` older than 24
hours with incomplete progress raises an alarm — an orphaned partition is a data-retention
problem, not just an untidy one.

**Tests.** Delete of a plan with 50 participants, 20 expenses, 40 updates and 3 attachments
first transitions it to `cancelled` and dispatches one `plan_cancelled` per participant,
then removes every item and every index entry — there is no code path that tombstones a
participant-bearing plan still in `scheduled`; the delete confirmation payload carries the
expense count, total and unsettled amount; the job resumes correctly when killed mid-way; the
plan is invisible immediately after phase one. A source ListItem remains byte-identical;
every viewer pointer still targeting the deleted Plan is removed, while a viewer pointer
already replaced with a newer Plan survives. A settled Expense blocks before the tombstone
and returns its exact Settlement ids; after explicit Undo, every Expense locator is removed
by the resumable cascade.

---

### P6-27 — Guest → account linking and the `GUESTEMAIL#` partition

**What to build.** The path from "Chloe was invited by email" to "Chloe signs up and her
Plans, Lists and reciprocal People relationships are already there". Closes OQ-9.

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
  4. **And converts every pending list membership for that person.** Query
     `USER#<ownerId>` with `begins_with LLINK#<personId>#`, retain invited rows, and address
     each `LIST#<l>` / `MEMBER#<personId>` directly. Set `status: 'active'`, `userId`,
     `reciprocalPersonId` and `joinedAt`; write the new user's `LIST#<l>` pointer; create or
     reuse the reciprocal Person for the owner; change the owner link to active and write the
     new user's active reciprocal link. This is the only place a pointer is created for an
     invited member.

**Finding memberships is a direct access pattern.** `GUESTEMAIL#` locates an owner-scoped
Person; that Person's `LLINK#` prefix locates only its invited/active Lists. It does not query
all owner List pointers, does not scan List partitions and is also the projection Phase 7
uses for `sharedListCount`, Person detail, merge and delete guards. `LLINK#` still grants no
access: the newly written `USER#/LIST#` pointer is the grant.
- Bounded work: the trigger has a five-second Cognito budget. It links at most the first 50
  activities and the first 20 list memberships inline; beyond either bound it writes
  `USER#<u>/LINKJOB#<ulid>` and the maintenance job finishes it. A trigger that times out
  **fails the sign-up**, which is far worse than a delayed link.

Rules, restated because each has been got wrong before:

- Verified email only. The trigger reads the `email_verified` claim and does nothing without
  it.
- No merge prompt on the new user's side, and the owner is **not** notified.
- Completed and cancelled activities are not back-filled.
- `personId` never changes, so expenses and balances continue to reconcile and simply become
  visible from the other side.
- Phone numbers are never a linking key.
- A `GUESTEMAIL#` locator is Person-level. Removing one pending membership removes its
  invited `LLINK#`, not the locator; successful account linking, Person/email deletion does.
- Every link logs `userId`, `ownerId`, `personId`, optional `activityId`/`listId` and the
  **hashed** email.

**Edge cases.** The same email may be a guest in several owners' address books; all of them
link. An owner adding an email to an existing guest `Person` that matches a registered user
links immediately on save, with the same effects. A user who deletes their account and signs
up again with the same address links again — which is correct.

**Tests.** Integration: a guest on three plans across two owners signs up and finds three
plans on Today and two new contacts; an unverified email links nothing; 60 matched activities
produce 50 inline plus a `LINKJOB#`; the trigger completes in under two seconds against
DynamoDB Local with 50 matches; removing a guest's email removes the `GUESTEMAIL#` row.

For lists: an address invited to two lists across two owners signs up and finds both on their
Lists tab, with `status: 'active'`, `reciprocalPersonId`, a pointer and active reciprocal
`LLINK#` each; both owners appear in the new user's People. Before signup, only each owner's
invited link exists, zero recipient pointers exist and every list route returns `404`. An
unverified email converts no membership. Removing one membership before signup deletes that
invited link but leaves the Person-level `GUESTEMAIL#`; signup links the Person and grants no
removed list. A repository spy asserts one targeted `LLINK#<personId>#` Query per owner and
no owner-wide List-pointer Query.

---

### P6-28 — Authorisation matrix enforcement and its test walk

**What to build.** One test file that walks the entire matrix in
[`../01-product/sharing-and-people.md`](../01-product/sharing-and-people.md) §3.4 with four
actors — owner, participant, declined participant, stranger — and one more for guests via
token.

**Approach.** The matrix is encoded as data, not as 60 hand-written tests. A fixture builds
one shared plan, one private plan and one prep task on the shared plan, and then asserts, for
every route and actor, the exact status code. A route added without a matrix row fails the test, because the test enumerates
the Hono router's registered routes and asserts every one has a row.

The middleware is the only place these rules live, and the route groups below make the shape
worth stating, because they are not all the same
([`../02-architecture/api-contract.md#3-authorisation-rules`](../02-architecture/api-contract.md#3-authorisation-rules)
§3):

| Route group | Owner | Participant | Why |
| --- | --- | --- | --- |
| `complete`, `uncomplete`, `skip`, `snooze` on a **plan** | Yes | **`403`** | Completion is **global**: an `Occurrence` records that the thing happened, not that somebody attended, and it carries no participant identity (ADR-048). One plan, one answer, and it is the owner's. |
| `complete`, `uncomplete`, `PATCH` on a **prep task** | Yes | **Yes** | Completion authority follows the object. A prep task is an item on a shared checklist, so any participant **of the parent** may tick it, whoever created it (ADR-051). |
| `schedule`, `PATCH`, `DELETE`, participant add and remove | Yes | `403` | Owner actions on somebody else's plan. |
| `reminders` (`GET`, `POST`, `DELETE`) | Own only | **Own only** | A reminder belongs to a person, not to a plan. Scoped by key construction from the token, so there is no id to authorise (P2-16, ADR-047). |
| `suggestions` (`GET`, `POST`, `works`) | Yes | **Yes** | Any participant proposes; only the owner decides (P6-48 to P6-50, ADR-049). `DELETE` is author or owner. |
| `PATCH .../participants/:personId` (RSVP) | Anyone's | Own only | The existing self-service exception. |

The row that is easiest to get wrong is the first, because "a participant should be able to
tick their own row" reads as obviously right and the storage cannot express it. There is no
per-participant completion and no key that could hold one; the feature and its cost are
deferred in [`../00-open-decisions.md`](../00-open-decisions.md) item 31. Phase 2 already
enforces this in `authz.ts` (P2-13); this task is where it is walked with a real participant
for the first time.

**The parent-participant rule.** The second row is the one branch that the ordinary owner
check does not produce: *a participant of the parent may act on a child*. When the loaded
`ACT#<id>/META` carries a `parentActivityId` and the caller is neither owner nor participant
of the child, `assertActivityAccess` reads the **parent's** `ACT#<parent>/PART#<personId>`
row and grants child-level access from it. The cost is stated so it is not discovered later:

- **One extra `GetItem` per authorised call on a child activity** — the parent's `PART#`
  row — or a request-scoped cached parent lookup where a handler already loaded the parent.
  It is one read, not a query, and it happens only when `parentActivityId` is present.
- The `parentActivityId` is read from the **stored** child item, never from the request body
  or path. A caller cannot name a parent to borrow its permissions
  ([`../02-architecture/security-privacy.md#1-threat-model`](../02-architecture/security-privacy.md#1-threat-model)
  row 1a).
- Nesting is capped at two levels (P1-10 rule 5), so the walk is one hop and cannot recurse.

**Tests.** The matrix itself. Plus: a stranger always gets `404`, never `403`; a participant
gets `403` (not `404`) for owner-only actions on a plan they can see; `notes` is stripped for
non-owners on `GET /v1/activities/:id` (privacy rule P9).

Plus three cases for the parent-participant rule, on one prep task owned by the plan owner:
the **owner of the child** completes it (`200`); a **participant of the parent who did not
create it** completes it (`200`) and edits its title (`200`); a **stranger** to the parent
gets `404` on both, never `403`. A fourth asserts the rule is scoped rather than general — a
participant of the parent gets `403` from `complete` on the **parent plan** itself.

Plus, asserted individually because each is a rule somebody will be tempted to relax: a
participant's `POST .../complete` returns `403` **and writes nothing**, verified by counting
the `ACT#<id>` partition before and after; the same for `skip`, `snooze` and `uncomplete`; a
participant's `GET .../reminders` returns only their own on a plan where three users have
them; a participant's `POST .../suggestions` returns `201` while their
`POST .../schedule { fromSuggestionId }` returns `403`.

---

### P6-29 — List membership repository, index fan-out and per-viewer Activity links

**Files.** `services/api/src/repositories/{listMembers,personListLinks}.ts`,
`services/api/src/repositories/listActivityLinks.ts`,
`services/api/src/repositories/__tests__/{listMembers,listActivityLinks}.int.test.ts`.

**What to build.** The write paths that turn Phase 3's one-pointer list into a shared one.
Phase 3 built the partition the right way round (P3-04), so this is additive: nothing about
the canonical `LIST#<l>` / `META` row changes. This task also extends Phase 3's
caller-specific `LNK#` repository so a deliberately shared Plan can project state to the
selected viewers who can access both objects.

The starting state is invariant: the owner is `META.ownerId` plus the existing owner pointer,
`memberCount` is `1`, and there are zero `MEMBER#` rows. Each successful add writes exactly
one non-owner row and increments the count; no operation creates an owner membership row.

**The fan-out, in both directions.**

| Operation | Items written | Count |
| --- | --- | --- |
| Add an app user as a member | `LIST#/MEMBER#`, member `USER#/LIST#`, owner `USER#/PERSON#` and reciprocal member `USER#/PERSON#` when absent, active owner and member `USER#/LLINK#`, `ADD memberCount :one` | **7 max** |
| Add an invitee with no account | `LIST#/MEMBER#` invited, owner `USER#/PERSON#`, owner invited `USER#/LLINK#`, Person-level `GUESTEMAIL#`, `ADD memberCount :one` | **5 max** — no recipient pointer or link |
| Remove a member, or a member leaving | `MEMBER#` delete, member `USER#/LIST#` delete, owner and member `LLINK#` deletes, `ADD memberCount :minus_one`; then query and batch-delete `LNK#<viewerUserId>#` rows | **5 transactional** + 0..500 pointer deletes |
| Remove an invited member | `MEMBER#` delete, owner invited `LLINK#` delete, counter | **3** — the Person-level `GUESTEMAIL#` remains |

Each membership transaction fits comfortably in one `TransactWriteItems`. Its largest write
is seven items, so unlike the participant fan-out (P6-12) there is no batching:
**membership changes one person at a time.** Departed-viewer `LNK#` cleanup is a subsequent
paged `BatchWriteItem`, and shared Plan creation reuses P6-12's participant batches rather
than pretending every selected person fits in this transaction.

> **Decision — no bulk member add.** `POST .../members` takes one person. The share sheet
> adding four people issues four calls and reports per-person results, exactly as the
> participant picker does. A bulk endpoint would need the same batching machinery as P6-12
> for a cap of 20 and a flow where partial success is the normal, visible outcome anyway.

**The shared-item Plan fan-out.** `POST /v1/lists/:id/items/:itemId/schedule` consumes the
strict `ScheduleListItemInput` from P6-11. It does not read the list or item to choose an
Activity type, destination, or audience:

1. `creationTarget` must be `{ objectKind: 'plan', type: <user-selected PlanType> }`.
2. `audience.mode: 'just_me'` writes the Plan, the caller's `IDX#`, and exactly one
   `LNK#<callerUserId>#<itemId>` pointer. No list member becomes a participant.
3. `audience.mode: 'selected_people'` applies exactly the submitted people through P6-12's
   participant batches. It writes a viewer pointer for the caller and for each successfully
   added **registered** participant who is also an active member of this list. A guest or a
   selected person outside the list receives Plan access but no pointer; an unselected list
   member receives neither.
4. Each pointer is `{ listId, itemId, viewerUserId, activityId, linkedAt }` at
   `LIST#<listId>` / `LNK#<viewerUserId>#<itemId>`. Writing a new one replaces only that
   viewer's current pointer. Another member's pointer is not a conflict and is never read to
   decide whether scheduling is allowed.
5. The `ITEM#` row is byte-identical before and after. Its title seeds the Plan title once
   when the request omits one; later title and note edits do not mirror in either direction.

The list-detail repository must project rows in this order: discard every `LNK#` whose
viewer prefix is not the authenticated caller; authorise the retained Activity ids; then
`BatchGetItem` the allowed Activities for state lines. It never fetches all linked Activities
and asks the client to hide them. The response calls the retained pointer `viewerLink`,
singular per item.

**The invited member has no index entry, and that is the whole design.** There is no
`USER#` partition to write into, because there is no user. Consequences, each of which is a
test:

- The list does not appear on their Lists tab, because there is nothing to appear.
- The owner has one invited `LLINK#` for signup, withdrawal and deletion guards. It counts
  toward `memberCount` and the cap, but not `sharedListCount` or `LISTS TOGETHER`.
- Every list-scoped route `404`s for them, because the pointer **is** the access check
  (P6-32).
- They can read nothing. There is no invite-token surface for a list, so a shared list has no
  public projection at all and nothing to leak.
- On signup with the verified email, P6-27's linking writes the pointer, and the list appears.

**Renaming stays one write.** The `META` row is canonical; `LIST#` pointers and `LLINK#` rows
carry ids, role/status and `addedAt`, not title. A rename by any member is one `UpdateItem` on
`LIST#<l>` / `META` regardless of member count.

**Edge cases.**

- The owner cannot be removed and cannot leave. The only exit for an owner is deleting the
  list. Ownership transfer does not exist in v1.
- Adding a person who is already an `active` member is a no-op returning the existing
  `ListMember` with `200`, not `409` — re-tapping a name in the share sheet must not error.
- Adding a person who is currently `invited` re-sends the email and returns `200`. It does
  not create a second row.
- Deleting a list must delete **every** member pointer, both sides of every active `LLINK#`,
  every invited owner link and every per-viewer `LNK#`. Extend Phase 3's resumable P3-05
  cascade. Every Activity and every `PERSON#` survives.
- `memberCount` is maintained with `ADD`, never by writing a computed value, so two
  concurrent membership changes cannot lose one. Its floor is `1`, because the owner is the
  implicit first member even though no owner `MEMBER#` row exists.

**Tests.** Integration against DynamoDB Local, asserting every budget row. An app-user add
creates/reuses reciprocal People, one member pointer and two active `LLINK#` rows with the
same immutable `addedAt`; a non-owner co-member gets no relationship row. An accountless
invite creates one owner invited link, zero recipient pointers and no active count. Removal
deletes relationship links but leaves both People and authored items. An add that would make
the total 21 people, including the owner and pending invitations, is refused before any write.
Renaming with 20 people writes one item.
Deleting a list with 20 people removes every list pointer, `LLINK#` and `LNK#`, while People
and Activities survive.

For `Plan this item`, use Alice and Ben as members of one list. Alice chooses `just_me` and
Ben's list response contains no Activity id, date, state, or navigation target. Ben then
chooses his own private Plan from the same item; both requests succeed and each response
contains only its caller's pointer. In a shared request, only explicitly selected registered
participants who are active list members get `LNK#` rows. Seed an `LNK#` for another viewer
that points to a forbidden Activity and assert the repository does not include that id in its
Activity `BatchGetItem` call, not merely that the serializer removes it later. Finally,
rename the item and each Plan independently and assert the other two titles remain unchanged.

---

### P6-30 — `POST /v1/lists/:id/members` and the invited-without-an-account path

**Files.** `services/api/src/routes/lists.ts` (extend),
`services/api/src/services/listMembers.ts`,
`services/api/src/email/templates/list-invitation.ts`.

**What to build.** The endpoint from
[`../02-architecture/api-contract.md#27-lists`](../02-architecture/api-contract.md#27-lists),
owner only, capped at 20.

**Approach.** Body is `{ personId }` or `{ displayName, email }`. The service:

1. Asserts the caller's pointer exists and its `role` is `owner` (P6-32). A non-owner member
   gets `403`; a non-member gets `404`.
2. Enforces `memberCount < 20`, else `422` with `A list can have up to 20 people.`
3. Resolves or creates the `Person` in the **owner's** partition, reusing the same resolution
   the participant path uses (P6-13). One People layer, two shareable objects.
4. If an existing Person already has `linkedUserId`, resolves that user directly. Otherwise
   looks a supplied email up in `EMAIL#<lowercased>`:
   - **A match** means a registered user. The `ListMember` row is written with `status:
     'active'`, `userId`, immutable `addedAt`, `joinedAt` and `reciprocalPersonId`. Create or
     reuse the owner's Person in the member's partition, then write the member pointer and
     active `LLINK#` rows in both partitions. The list appears on Lists and the owner appears
     in People immediately. No email is sent; app users get the in-app notification path.
   - **No match** means no account. The `ListMember` row is written with `status: 'invited'`,
     immutable `addedAt`, **no `userId`, no `reciprocalPersonId` and no recipient pointer**;
     the Person-level `GUESTEMAIL#` and owner-side invited `LLINK#` are written, and one email
     is sent. It counts toward `memberCount` and the cap, but not the active People summary.
5. Returns the `ListMember`.

Neither branch writes `PLINK#`, changes `upcomingCount`/`lastActivityAt`, or adds the person
to FREQUENT/RECENT. Those projections remain about explicitly shared Plans. The list title,
template and item words never decide the member or relationship; the submitted Person does.

**The email.** `list-invitation` is a **fourth** SES template, alongside the three from
P6-04. It says who invited them, what the list is called, and that they need the app to use
it; it carries a link to the App Store, no list content and no item titles. There is nothing
to show a stranger, because a list has no public projection — which is why this email is a
plain invitation rather than a link to a page.

> **Four sends, not three.** [`../01-product/notifications.md`](../01-product/notifications.md)
> §6.3 lists this send as `list_invitation_email`, `api-contract.md` §2.7 requires it, and
> P6-04's acceptance test asserts exactly **four** exported send functions. A pull request
> that reduces the service to three fails that test.

**Edge cases.**

- `{ displayName }` with no email is `validation_failed`. A list member with no address
  cannot be reached and cannot ever become active, so the row would be permanently inert.
  This is the one place list membership is stricter than plan participation, and the reason
  is in the canonical model: **list membership is app users only**, so an address is the
  route to an account rather than an optional nicety.
- Adding yourself is `validation_failed`.
- The response does not reveal whether an address has an account to anyone but the caller,
  and the caller typed it — the same reasoning as P6-13.
- An email send failure does not fail the request. The member row exists with `status:
  'invited'` and the owner's row reads `Invite not sent · Resend`.
- Archived lists accept members. A list being out of the index is not a reason to refuse.

**Tests.** Owner adds an existing app user: active membership, reciprocal People, two active
links with one `addedAt`, one access pointer, list on Lists and owner on People, no email.
Owner adds an unknown address: invited membership and owner link, zero recipient pointers,
one Person-level `GUESTEMAIL#`, one email, and no active shared-list count. In both cases
assert zero `PLINK#` writes and unchanged activity counters/rankings. A member adding someone
gets `403`; a stranger gets `404`. An add that would make `memberCount` 21 returns `422` and
writes nothing. `{ displayName }` with no email `400`s. A duplicate add returns `200` and
writes no second row or link.
`{ personId }` for a Person with `linkedUserId` but no usable email takes the active path and
sends no email.

---

### P6-31 — `DELETE /v1/lists/:id/members/:personId` — remove and leave

**What to build.** Two operations behind one route, the same shape as P6-16 for
participants: the owner removing someone, and a member leaving.

**Approach.** Both delete the `MEMBER#` row and owner-side `LLINK#`; when the member is active,
the same transaction also deletes their list-index pointer and reciprocal member-side
`LLINK#` using `reciprocalPersonId` plus immutable `addedAt`, then decrements `memberCount`
(P6-29). After it commits, query
`LIST#<listId>` with `begins_with LNK#<departedUserId>#` and batch-delete every per-viewer
Activity pointer. That cleanup is idempotent and may page across the 500-item cap. The missing
list-index pointer ends access before cleanup begins, so no stale `LNK#` can authorise a read.
Removing an invited member deletes its owner-side invited link. It does **not** delete the
Person-level `GUESTEMAIL#`, which may still locate another Plan or List relationship; later
signup finds no link for the withdrawn List and therefore cannot resurrect it.

**What happens to a departed member's items, stated because the obvious implementation
deletes too much:** **nothing.** Their items stay in the list, with their titles, their
ranks, their notes and their checked state. A grocery list does not forget the milk because
the person who typed it left the household. This is the same rule as expenses surviving a
participant's removal (P6-16), and it holds for the same reason: the list is the shared
object, not a per-person view of one.

Items carry no author attribution in v1, so there is nothing to relabel either. Adding one
would create a per-item identity the model does not have and would raise a question — what do
you show for a departed member — that nobody has asked.

Plans created from the list also survive. Removing a member deletes only that person's
viewer-local pointers; it does not delete, unshare, or edit any Activity, and it does not
fall back to an older pointer.

Both owner-scoped `PERSON#` records survive. A list relationship ending is not permission to
delete either user's contact or any Plan/expense history.

**Edge cases.**

- Removal is confirmed in the UI and has **no undo**, per the interaction contract. Re-adding
  is a fresh invitation.
- The owner cannot be removed and cannot leave.
- A member removing another member gets `403`. A member removing themselves is the leave
  path and succeeds.
- Leaving a list the user does not belong to is `404`, not `204`.
- Access ends immediately: the pointer is gone, so the next request `404`s. There is no cache
  window on the server, and the client's cached copy is a client concern (P9-06).

**Tests.** Owner removes a member; a member leaves; a member cannot remove another; the owner
cannot leave; a removed member's items survive with every field intact and the list's
`itemCount` unchanged; all of their `LNK#<user>#` rows are gone while the referenced Plans
survive; another viewer's links are byte-identical; a removed member's next request to any
list route returns `404` immediately, including while link cleanup is still paging; both
active `LLINK#` rows (or the invited owner link) are gone while both People remain; removing
one invited membership leaves the Person-level `GUESTEMAIL#`, and a subsequent signup with
that address grants no removed list.

---

### P6-32 — List authorisation: the two roles in the middleware

**Files.** `services/api/src/services/authz.ts` (extend with `assertListAccess`),
`services/api/src/middleware/authz.ts`.

**What to build.** `assertListAccess(userId, listId, level)`, the list-shaped sibling of
`assertActivityAccess`, in the **same file** and enforced in one middleware rather than in
handlers.

```ts
type ListAccessLevel = 'member' | 'owner';
assertListAccess(userId, listId, level): Promise<{ role: ListRole; list: List }>;
```

**Approach.**

1. `GetItem` the caller's pointer, `USER#<u>` / `LIST#<l>`. **Absent → `404 not_found`,
   never `403`**, exactly as for an activity, so a stranger cannot learn that a list id
   exists. This is the row-1 IDOR mitigation in
   [`../02-architecture/security-privacy.md`](../02-architecture/security-privacy.md) §1
   applied to the second multi-user object.
2. The pointer carries `role`, so the check is **one `GetItem`**. No `MEMBER#` query, no scan
   of the member list. This is what the pointer is for.
3. `level: 'owner'` with `role: 'member'` → `403 forbidden`. The caller can see the list, so
   hiding it would be a lie and would make the `Leave` affordance inexplicable.
4. Route levels, from
   [`../02-architecture/api-contract.md#3-authorisation-rules`](../02-architecture/api-contract.md#3-authorisation-rules):

| Route | Level |
| --- | --- |
| `GET /v1/lists/:id`, `/items`, `/members` | `member` |
| All item writes: `POST`/`PATCH`/`DELETE .../items*`, `clear-checked`, item `schedule` | `member` |
| `PATCH /v1/lists/:id` with `title` only | `member` |
| `PATCH /v1/lists/:id` with `capabilities`, `behaviour` or `slot` | `owner` |
| `POST /v1/lists/:id/members`, `DELETE /v1/lists/:id/members/:other` | `owner` |
| `DELETE /v1/lists/:id/members/:self` | `member` — the leave path |
| `DELETE /v1/lists/:id` | `owner` |

The `member` grant on item `schedule` means only "may open and submit Plan this item." It
does **not** turn list membership into Activity access. The handler must still require the
explicit `creationTarget` and audience, create participants only from
`selected_people.participants`, and return only the caller's `viewerLink`. A member not
selected for the new Plan cannot read it even though they can still edit the source item.

Row 4 is the only field-sensitive one: the level depends on **which keys** the patch body
carries, not on the route. Compute it from the parsed body, reject the whole request if any
key requires `owner` and the caller is a `member`, and never apply half a patch — the same
rule P3-09 already applies to destructive capability changes.

**A member cannot change behaviour or capabilities**, and the reason is the interaction
contract rather than a trust hierarchy: those changes drop typed fields from every item in
the list, and a destructive change to shared data belongs to the person who owns it.

**Edge cases.**

- An `invited` member has no pointer, so every route `404`s. There is no branch for `status`
  in the middleware at all, which is the point of not writing the pointer.
- The list's `archived` state does not affect authorisation.
- The middleware loads the pointer once per request and puts `role` on the context, so a
  handler never re-reads it.

**Tests.** A route-enumerating matrix test in the shape of P6-28, with four actors — owner,
member, invited member, stranger — over every list route, asserting the exact status code.
The test enumerates the Hono router's registered list routes and fails if one has no matrix
row. Specifically: a member `PATCH`ing `title` succeeds; the same member `PATCH`ing
`capabilities` gets `403` and **writes nothing**; a `PATCH` carrying both `title` and
`capabilities` from a member is rejected whole; a non-member gets `404` on every route
including `GET`; an invited member gets `404` on every route.

For item scheduling, a member may create a `just_me` Plan (`201`); another member gets `404`
from the new Activity and receives no id through list detail. The same caller may choose
people explicitly. Omitting audience or Plan type is `400`, and no membership or Activity
row is written.

---

### P6-33 — Minimal People read surface for the picker

**What to build.** Just enough of the People API for the picker to work. The People page,
Person view, balances and the FREQUENT ranking are Phase 7.

**Approach.** `GET /v1/people` returns every `PERSON#` row for the caller, name-sorted, with
`upcomingCount`, `lastActivityAt` and computed `sharedListCount` from that Person's active
`LLINK#` rows. This is what makes a list-only explicit contact visible; invited links do not
count. `GET /v1/people/suggested` returns
`{ frequent: [], recent: [...] }` — RECENT is people with a shared activity in the last 30
days, ordered by `lastActivityAt`, capped at 8, computed from `PLINK#` rows. `frequent` ships
empty in this phase and the picker renders no FREQUENT heading when it is; Phase 7 fills it.
Search is a client-side substring match over `GET /v1/people` until the list justifies a
server-side one.

`upcomingCount` and `lastActivityAt` are maintained on every participant write and on every
reschedule, in the same transaction. List membership and list edits never change them, and
`LLINK#` never contributes to FREQUENT or RECENT.

**Tests.** RECENT window boundaries at exactly 30 days; ordering; the cap; counters updated on
Plan add, remove, reschedule and completion. A list-only app-user share appears with
`sharedListCount: 1`; an invited link appears with `0`; list edits and membership changes do
not alter activity counters or suggested buckets.

---

### P6-34 — The participant picker sheet

**What to build.** The sheet in
[`../01-product/sharing-and-people.md`](../01-product/sharing-and-people.md) §2.2, on both
platforms.

**Files.** `apps/mobile/src/features/people/components/ParticipantPicker.tsx`,
`.../hooks/useSuggestedPeople.ts`, `.../model/pickerState.ts`.

**Approach.** One search field, selected chips above the buckets, FREQUENT and RECENT lists,
and a `+ Add "<name>" as a new person` row when nothing matches. Selection is applied on
`Done`: one `POST .../participants` per person on an existing Plan, held in local state and
sent inside `CreateActivityInput.participants[]` on a new Plan, or returned to
`ScheduleListItemInput.audience.selected_people` when P6-43 embeds the picker. It is never
available on a Task. The 51st selection is
refused inline with `You can add up to 50 people to a plan.` and never reaches the network.

The sheet's footer holds two rows in this order: `+ Add "<name>" as a new person` (when the
typed text matches nothing) and `⊕ Choose from Contacts` (persistent on iOS, absent on web).
Both end at the same two-field form, so P6-35 adds an entry point to this sheet rather than a
second flow. Build the footer as a slot here; P6-35 fills the second row.

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

### P6-35 — `expo-contacts` OS contact-picker integration

**What to build.** The `⊕ Choose from Contacts` row, and the narrowest possible use of
`expo-contacts` behind it.

**Files.** `apps/mobile/src/features/people/contacts/pickContact.ts`,
`.../contacts/pickContact.web.ts`, `.../components/ContactValueSheet.tsx`,
`apps/mobile/app.config.ts` (the plugin entry).

**Approach.** The spec is
[`../01-product/sharing-and-people.md`](../01-product/sharing-and-people.md) §2.3. One
function, one call:

```ts
// pickContact.ts — the ONLY module in the app allowed to import expo-contacts
import * as Contacts from 'expo-contacts';

export async function pickContact(): Promise<PickedContact | null> {
  const contact = await Contacts.presentContactPickerAsync();  // one contact, or null
  if (!contact) return null;                                   // user cancelled
  return {
    displayName: contact.name ?? '',
    emails: (contact.emails ?? []).map((e) => e.email).filter(Boolean),
    phones: (contact.phoneNumbers ?? []).map((p) => p.number).filter(Boolean),
  };
}
```

> **Decision — picker, not sync.** `presentContactPickerAsync` runs the system picker **out
> of process** and hands back only the contact the user tapped, so the flow needs no
> `CONTACTS` read permission on iOS, adds nothing to the App Store privacy label, and leaves
> no address-book data at rest. Full-address-book import and contact-matching against other
> app users are rejected outright: the first is a permission prompt plus third-party PII at
> rest with a deletion obligation, the second is a social-graph feature the product does not
> want ([`../01-product/sharing-and-people.md`](../01-product/sharing-and-people.md) §7).

Rules, enforced by review and by the tests below:

- `pickContact.ts` is the only file that may import `expo-contacts`, enforced by a
  `dependency-cruiser` rule. Nothing else in the app may reach the module.
- The only `expo-contacts` export used is `presentContactPickerAsync`. `getContactsAsync`,
  `getContactByIdAsync`, `requestPermissionsAsync` and `getPermissionsAsync` are banned by a
  lint rule with a message naming this task.
- The returned object is mapped to `PickedContact` at the boundary and the `expo-contacts`
  `Contact` type never crosses into feature code. Nothing else on the contact — `id`,
  image, birthday, addresses, company, note — is read or carried.
- Nothing is persisted at this step. `pickContact` returns a value into the sheet's local
  state; the write happens through the existing `POST .../participants` path.
- No `NSContactsUsageDescription` is added to `app.config.ts` for this flow. If one turns
  out to be required by a future SDK, that is a product decision, not a config fix.

**Contacts with several values.** The `emails` and `phones` arrays may hold more than one
entry. `ContactValueSheet` lists them with the first preselected, the user picks exactly one
of each, and `Skip` leaves the field empty — which produces a legal guest with a copyable
link. Unpicked values are dropped, never stored "in case".

**Edge cases.**

- User cancels the OS picker: `null`, the sheet returns to its prior state, nothing is
  written and no error is shown.
- A contact with no name at all: the two-field form opens with an empty, focused name field
  and `Done` stays disabled until it is filled.
- A contact whose email is not a valid address (address books hold anything): the value is
  offered in `ContactValueSheet` and validated in the form like a typed one; an invalid one
  is rejected inline rather than silently dropped.
- The picker on a device with an empty address book returns `null` after the user dismisses
  it. There is no "you have no contacts" state to build.
- The 50-participant cap is checked before the picker opens, not after, so the user is not
  sent through the OS UI to be refused on return.

**Tests.** Unit tests on `pickContact` with `expo-contacts` mocked: the mapping, the
cancel path, the multi-value pass-through, and that no field beyond name/emails/phones is
read. A build-level test asserting exactly one import of `expo-contacts` in the whole app
and that the banned exports appear nowhere. A `ContactValueSheet` component test per
branch. Maestro on a simulator with seeded contacts: pick a contact, confirm the person
appears on the plan.

---

### P6-36 — Duplicate-person match on a picked contact

**What to build.** The check that stops the picker filling the user's people with second
copies of people they already have.

**Files.** `apps/mobile/src/features/people/model/matchPerson.ts` (pure),
`.../components/ExistingPersonSheet.tsx`.

**Approach.** A pure function over the people list already loaded for the picker
(`GET /v1/people`, P6-33), so the match costs no request:

```ts
matchPerson(picked: PickedContact, people: Person[]): Person | null
```

1. **Lowercased email equality** against `person.email`. Whitespace trimmed, no other
   normalisation — no plus-address stripping, no dot-folding; those rules differ per
   provider and guessing them merges two real people.
2. If the picked contact has no email, **exact display-name equality** after trimming and
   case-folding.
3. Otherwise `null`.

On a match, `ExistingPersonSheet` offers `Use <name>` (selects the existing `Person`, so the
add path is the ordinary `{ personId }` body) and, secondary, `Add as a new person`. **A
duplicate is never written silently**, and the user is never blocked from creating one
deliberately — two people do share a name, and `POST /v1/people/:id/merge` (Phase 7) is the
repair route when they get it wrong.

**Edge cases.**

- The match is already selected in this sheet: no sheet is shown, the existing chip is
  highlighted, and the selection count does not change.
- Two existing people match the same email: cannot happen for email (it is unique per owner
  in practice) but can for a name. Show the first by `displayName` ascending, and the sheet
  lists the others under `Someone else?`.
- Phone numbers are **never** a match key, consistent with
  [`../01-product/sharing-and-people.md`](../01-product/sharing-and-people.md) §5.2. Formats
  vary too much to compare safely and a wrong phone match links two strangers.
- The picked email matches a registered app user's verified email: that is P6-13's job on
  the server, not this function's. The client shows the `Has the app` badge only after the
  add returns.

**Tests.** Table-driven on `matchPerson`: email match, case-insensitive email match, email
mismatch with equal names (no match, because the emails disagree), no-email name match,
no-email name mismatch, empty people list, and a plus-addressed email that must **not**
match its base address. Component tests for both sheet branches, and an integration
assertion that `Use <name>` sends `{ personId }` and never `{ displayName, email }`.

---

### P6-37 — Web fallback: manual entry, no picker

**What to build.** The absence of the picker on web, done deliberately.

**Files.** `apps/mobile/src/features/people/contacts/pickContact.web.ts`,
`.../components/ParticipantPicker.tsx` (the footer slot).

**Approach.** There is no OS contact picker on the web. `pickContact.web.ts` exports
`isContactPickerAvailable = false` and a `pickContact` that throws if called, and the
`⊕ Choose from Contacts` row is **not rendered** on web — not disabled, not present with
an explanation. Web users add people by typing a name and an optional email, which is the
flow that already exists and is complete on its own.

> **Decision:** no shim. The browser Contact Picker API is Chromium-on-Android only, needs a
> secure context, and would give the web build a capability iOS Safari and desktop do not
> have — a platform difference that has to be explained in copy for a feature that saves one
> paste. It is listed as a deliberate gap in
> [`../02-architecture/tech-stack.md`](../02-architecture/tech-stack.md) §3.5 rather than
> worked around.

**Edge cases.** The two footer rows must not leave a dangling divider on web when only one
is present. Nothing else in the sheet changes shape by platform; the buckets, the cap and
the `Done` behaviour are identical.

**Tests.** A web render test asserting the row is absent from the tree entirely (not merely
hidden), an iOS render test asserting it is present, and a Playwright pass over the add flow
on web asserting a person can still be added by typing.

---

### P6-38 — Plan detail: PEOPLE section, share sheet, invite-link affordances

**What to build.** The PEOPLE section of the plan detail
([`../01-product/plans-and-lists.md`](../01-product/plans-and-lists.md) §2.1 item 3) and the
`Share` header action.

**Approach.** Each participant row shows the display name, RSVP state in words, and a `guest`
badge where applicable. The owner's swipe actions are `Resend invite`, `Copy link`, `Remove`,
all also present in the row's `⋯` menu. `Share` opens the picker; a secondary
`Copy invite link` creates or reuses a shareable invite. Tapping a participant row opens that
Person's view — which in this phase is a minimal screen showing the name, the `Has the app`
badge, and the shared-plans list; Phase 7 fills in the rest.

**Tests.** Component tests per row state; the owner-only actions are absent for a participant;
a guest row shows the copyable link; `Remove` shows a confirmation and offers no undo.

---

### P6-39 — RSVP affordances on agenda rows and in the inbox

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

### P6-40 — The RSVP label switch: dated and undated vocabulary

**Files.** `packages/shared/src/activities/rsvpLabels.ts` (pure),
`apps/mobile/src/features/plans/model/rsvpSummary.ts` (extend, P3-35),
`apps/mobile/src/features/agenda/components/RsvpControl.tsx`.

**What to build.** One pure function that turns a stored RSVP value plus "does this plan have
a date" into the word the user sees.

```ts
function rsvpLabel(rsvp: Rsvp, hasDate: boolean): string;
```

| Stored | Undated | Dated |
| --- | --- | --- |
| `going` | `Interested` | `Going` |
| `maybe` | `Maybe` | `Maybe` |
| `declined` | `Pass` | `Decline` |
| `pending` | `Hasn't replied` | `Hasn't replied` |

**The stored values never change.** `interested` is not an enum member, is not written, is
not migrated, and does not exist anywhere in the data model. It is the same state with a
different word on it, and storing it would force a data migration every time somebody picks a
date — which is exactly the event the word changes on. The canonical statement is in
[`../02-architecture/data-model.md#71-rsvp-consent-does-not-survive-a-date-change`](../02-architecture/data-model.md#71-rsvp-consent-does-not-survive-a-date-change):
*do not add `interested` to the enum.*

**Approach.** The signal is `Boolean(activity.schedule?.date)`, read from the same response
the row is rendering, so the label cannot disagree with the row it sits on. Every surface
that renders an RSVP calls this function: the inline `Going · Maybe · Decline` control on an
agenda row, the PEOPLE section of plan detail, the needs-a-date row's summary (P3-35), the
notification inbox, and the updates feed's `rsvp_set` entry.

**The public invite page and the guest emails are also surfaces of this function**, and this
is the correction worth stating plainly: an undated plan **does** have a meaningful invite
page. It has a title, a place, an organiser and a question — "do you want to do this?" — and
the whole point of a plan that exists before its date is that it can be agreed to first.
Guests reach it exactly as app users reach Needs a date. What an undated plan lacks is an
exportable calendar event, which is why `.ics` returns `409` (P6-20) and the add-to-calendar
affordances are hidden; that is a separate rule about `.ics`, not about the page.

So the public surface switches with everything else: undated reads
`The date is being decided` with **Interested · Maybe · Pass**, dated reads
**Going · Maybe · Decline** (P6-45, P6-04). It cannot import this function — the invite page
bundle imports nothing authenticated — so it takes `dateStatus` from the projection (P6-18)
and reads the same string keys. The **table above is the single source**, and a test asserts
the public page's rendered words equal `rsvpLabel`'s output for both date states, so the two
copies of the vocabulary cannot drift.

**Edge cases.**

- The undated control reads `Interested · Maybe · Pass`. It is the same three buttons writing
  the same three values.
- A guest who answered `Interested` or `Maybe` while the plan was undated is reset and
  re-emailed when a date lands
  (P6-15), so nobody ever sees `Going` attached to a reply they gave as `Interested` — on any
  surface, authenticated or not. A `Pass` is stored `declined` and survives the date change,
  unre-asked, like every other decline.
- When a date lands, every response except a `declined` one resets (P6-15), so nobody sees
  `Going` attached to a reply they gave as `Interested`. The two rules are designed together.
- The words live in the strings module like all other copy, so this function returns a key,
  not a literal, and localisation later is a swap.

**Tests.** A table over all eight combinations of four stored values and two date states. A
**test asserting the RSVP enum has exactly four members** — `pending`, `going`, `maybe`,
`declined` — compared to a checked-in literal array, so adding `interested` fails CI. A grep
test asserting the string `interested` appears in no schema, no type and no repository, only
in the strings module. A render test that the same participant row reads `Interested` before
a date is set and `Going` after, with the stored value byte-identical in both reads. And a
cross-surface test: for both date states, the words rendered by the public invite page equal
`rsvpLabel`'s output for the same state, so the unauthenticated copy of the vocabulary cannot
drift from the authenticated one.

---

### P6-41 — Updates feed UI

**What to build.** The UPDATES section of the plan detail, newest first, with a composer.

**Approach.** System entries render from `code` + `params` through the strings module. User
entries show the author's display name and a relative timestamp. The author may delete their
own entry via swipe. Posting is optimistic. The section is hidden on a private plan with no
entries.

**Tests.** Rendering of each system code; pagination; the author-only delete; an unknown
future `code` renders a neutral fallback rather than crashing — a shipped client must survive
a server that learned a new code.

---

### P6-42 — Add-to-calendar affordance on plan detail

**What to build.** `Add to calendar` in the plan's `⋯` menu, offering Google, Apple and
`Download .ics`.

**Approach.** iOS: `Apple` fetches `/v1/activities/:id/ics` and hands the file to the system,
which opens Calendar. Web: `Apple`/`Download` triggers the same URL with `?download=1`;
`Google` opens the built URL in a new tab. Nothing calls the public endpoints from an
authenticated screen.

**Tests.** Platform-branched unit tests for the URL chosen; a Playwright assertion that the
downloaded file's `Content-Type` is `text/calendar`.

---

### P6-43 — List share, shared-item audience, MEMBERS and leave flows

**Files.** `apps/mobile/src/features/lists/{ListShareSheet.tsx, ListMembersSection.tsx,
PlanThisItemSheet.tsx, hooks/useListMembers.ts}`.

**What to build.** The client half of P6-30 and P6-31, reusing the participant picker rather
than building a second people UI. The behaviour, the sheet anatomy and every string are
canonical in
[`../01-product/plans-and-lists.md#5111-the-share-sheet`](../01-product/plans-and-lists.md#5111-the-share-sheet)
§5.11.1 and
[`#5114-leaving-and-being-removed`](../01-product/plans-and-lists.md#5114-leaving-and-being-removed)
§5.11.4; this task says where the code goes, not what the product does.

**Approach.**

- `Share` in the list header's `⋯` menu opens the **same** `ParticipantPicker` component
  (P6-34) with a different submit handler and a different cap. One people picker in the
  product; two things it can attach people to.
- The picker's cap copy changes to `A list can have up to 20 people.` The client computes
  `memberCount + distinctNewSelections <= 20`; a selection that would create person 21 is
  refused inline before the network, exactly as the selection that would create participant
  51 is.
- Selection is applied on `Done` as one `POST .../members` per person, with per-person
  results. A partial failure leaves the succeeded ones in the list and shows one banner
  naming the failures with `Retry`.
- **A person with no email cannot be added.** The picker's rows are disabled for contacts
  with no address, with the reason on the row: `Needs an email address`. `+ Add "<name>" as a
  new person` opens the two-field form with the email field **required** here, which is the
  one place it differs from the plan flow.
- The MEMBERS section on the list detail screen shows each member's display name, their role
  in words, and, where `status` is `'invited'`, `Invited · we emailed them` for someone with
  no account. A registered app user is active immediately; there is no opened/not-opened
  membership state (§5.11.1). `useListMembers` consumes the server's owner-first DTO; it does
  not look for or fabricate an owner `MEMBER#` row. Invited rows and addresses are projected
  to the owner only; an active member sees the owner and active roster. The owner's swipe
  actions are
  `Resend invite` and `Remove`, both also in the row's `⋯`. A member sees active names and nothing
  actionable but their own `Leave`.

**Plan this item on a shared list.** Extend the Phase 3 item action without changing its
name or adding a shortcut inferred from the list:

1. `Plan this item` first presents **General / Meal / Watch / Event** in that fixed
   order. None is selected, recommended, or reordered from the list's title, template,
   behaviour, item words, or typed details.
2. After the user taps one, the matching Plan form opens. The item title and compatible
   fields are editable pre-fills only; the chosen `PlanType` is fixed unless the user goes
   back and chooses again.
3. Before save, a required audience step presents exactly **Just me** and **Choose people**,
   with neither pre-selected. **Choose people** opens the existing picker empty. List members
   may appear as options but none is checked automatically; membership is not participation.
4. `Save plan` submits `ScheduleListItemInput` with the explicit Plan `creationTarget` and
   audience. Before that tap there is no Activity, participant, or `LNK#` write.

After save, the list row renders state only from the response's caller-scoped `viewerLink`.
The client never receives all viewers' links, never reads `ListItem.linkedActivityId`, and
never mirrors a later title edit between the item and Plan.

**The leave flow.** `Leave list` in the `⋯` menu, for a member and never for the owner. It is
destructive under the interaction contract, so it is a confirmation dialog with no undo. The
copy is
[`../01-product/plans-and-lists.md#5114-leaving-and-being-removed`](../01-product/plans-and-lists.md#5114-leaving-and-being-removed)
§5.11.4 verbatim, counts included:

```
Leave "Groceries"?

This removes the list from your Lists.

Keeps: all 14 items on it. Alice keeps the list.

                                    [ Cancel ]  [ Leave ]
```

The `Keeps:` line is the honest one and it is the question every user asks. Their items stay
(P6-31). Confirming issues one `DELETE .../members/<self>`, removes the list from the cached
index immediately, and navigates back to the Lists tab.

**What a member cannot do, and how it renders.** The list settings sheet (P3-32) shows
`behaviour`, `capabilities` and `slot` as **read-only rows with a one-line reason** for a
member — `Only <owner name> can change this` — rather than hiding them. A hidden control is
indistinguishable from a missing feature; a disabled one with a reason explains the shape of
the product. `Rename` stays editable, because a member may rename.

**Edge cases.**

- Removing the last member does not make the list private in any special sense. It is a list
  with one member, which is what every list starts as.
- A member removed while they have the list open sees their next write fail with `404` and
  gets one banner reading `You're no longer on this list.` and a bounce to the Lists tab. It
  is not a crash and it is not silent.
- The share sheet is unavailable on an archived list only if the list is also deleted — it is
  not. Archived lists can be shared.

**Tests.** Component tests for the picker at the 20 cap, the disabled no-email row, and the
required-email new-person form; the MEMBERS section rendered for owner, member and invited
member; the leave dialog's copy asserted verbatim, including the items line; a test that a
member's settings sheet renders the three controls read-only with the reason and that the
rename field is editable. Playwright: leave a list and assert it is gone from the index and
that a direct navigation to it returns the not-found screen.

For `Plan this item`, render tests assert the Plan-kind chooser and audience step both start
with no selection across every list template. The submit button remains unavailable until
both choices are explicit. One test enters `Watch Severance` on a Groceries list and still
shows the unchanged five-kind chooser, proving words and template do not classify it. With
Alice and Ben on the list, choosing **Just me** submits no participants; choosing people with
Alice selected submits Alice and not Ben. A two-context Playwright flow gives Alice and Ben
different private Plans from the same item and proves each row opens only its own Plan.

---

### P6-44 — A shared plan suggests sharing its generated lists

**Files.** `apps/mobile/src/features/lists/NewListSheet.tsx` (extend, P3-26),
`apps/mobile/src/features/plans/AddListSheet.tsx` (P3-38).

**What to build.** One unticked row on the sheet that creates a list from a plan, after the
user explicitly selects its list style, per
[`../01-product/plans-and-lists.md`](../01-product/plans-and-lists.md) §4.1:

```
  ☐  Share with Alice and Ben
     They can add and check items.
```

**Rules, all five of which are tests.**

1. The sheet first shows the full fixed-order template catalogue with nothing selected. The
   source Plan's kind, title, participants, date, and generated-list suggestion never choose,
   rank, or preselect a template. `POST /v1/lists` carries the exact user-selected
   `templateKey`; there is no title matcher or simple-list fallback.
2. **Unticked by default, on every template, with no exceptions.** Creating one thing never
   shares another. This is the product-wide invariant in
   [`../01-product/interaction-contract.md`](../01-product/interaction-contract.md#1a-product-wide-invariants)
   §1a.2 applied to a second object.
3. Ticking it adds every **app-user** participant of the plan as a `member`, in the same
   confirmation, as one `POST .../members` per person.
4. Guests are not added, and the row says so when the plan has any:
   `Alice can be added. Chloe doesn't have the app.` List membership is app users only.
5. The row is **not rendered at all** for a private plan, and declining is silent and final
   for this creation — the plan never asks again. The list can be shared later from its own
   share sheet (P6-43).

> **Decision — suggested, never automatic, and never pre-ticked.** For packing this is not a
> nicety: each person packs their own bag, and a shared `Packing · New York Trip` where three
> people tick one `Charger` row is actively wrong. Groceries and `Places to visit` for the
> same trip usually should be shared. The app cannot tell which is which from the template,
> so it asks once, cheaply, and defaults to the answer that loses nothing.

**Edge cases.** If the plan gains participants after the list was created, nothing happens —
there is no watcher and no retroactive suggestion. If adding one member fails, the list still
exists and the banner names the failure; a list that was not created because the fourth
invite failed would be worse.

**Tests.** The template catalogue starts unselected for Meal, Watch, Event and General
Plans; changing the proposed title does not change selection; save is unavailable until a
style is tapped; the request carries that exact `templateKey`; a missing key is `400` and
writes no list. The share row is absent for a private plan and unticked for a shared one, on
every template in the catalogue — a table-driven render test, because "except for packing"
is exactly the kind of exception that gets added later. Creating without ticking writes the
list and **zero** `MEMBER#` rows, asserted by a table item count. Ticking with two app users
and one guest writes two `MEMBER#` rows and renders the guest line. A second list created
from the same plan shows the style catalogue unselected and, after selection, the share row
unticked again.

---

### P6-45 — The public invite page

**What to build.** `apps/mobile/app/invite/[token].tsx`, the only unauthenticated screen in
the product.

**Approach.** Pre-rendered by the static export so the route has a real HTML file that
CloudFront serves and a crawler can read; the plan data is fetched client-side from
`/public/v1/invites/:token` and is never baked into the HTML. Layout per
[`../01-product/sharing-and-people.md`](../01-product/sharing-and-people.md) §4.2. Hard rules:

**The page has two vocabularies, chosen by `dateStatus` from the projection (P6-18).** A plan
whose date is not settled is a real plan with a real invite page, and asking a guest "are you
coming?" about it is incoherent:

| | `dateStatus: 'undecided'` | `dateStatus: 'scheduled'` |
| --- | --- | --- |
| The when block | `The date is being decided.` | The date, the time and the timezone label |
| The three buttons | `Interested` · `Maybe` · `Pass` | `Going` · `Maybe` · `Decline` |
| Add to calendar | **Absent.** There is no event to export | `.ics`, Google, Apple |
| After answering | `We'll email you when there's a date.` when they left an email; otherwise the plain confirmation | The ordinary confirmation |

The stored values are the same four in both columns
([`../02-architecture/data-model.md#71-rsvp-consent-does-not-survive-a-date-change`](../02-architecture/data-model.md#71-rsvp-consent-does-not-survive-a-date-change)),
and the words match `rsvpLabel` exactly (P6-40), asserted by a test rather than by two people
reading two tables. When a date lands a non-declined guest is reset and re-emailed (P6-15), so the second
visit asks the second question honestly rather than showing an old answer under a new word.

Hard rules:

- **Guests cannot suggest dates.** The suggestions section does not exist on this page, in
  either state, and the projection does not carry one (P6-18). A guest reads and RSVPs.
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

Plus the two vocabularies end to end: an undated token renders `The date is being decided`,
the three words `Interested`, `Maybe` and `Pass`, and **no** add-to-calendar affordance;
tapping `Interested` stores `going`. The owner then schedules the plan, and the same token
reloaded renders the date, `Going · Maybe · Decline`, and a `pending` state — not the earlier
answer. A test asserting the rendered word set equals `rsvpLabel`'s output for each state, and
one asserting the page contains no suggestion affordance in either state.

---

### P6-46 — E2E and projection-leak tests, S4 and S8

**What to build.** The CI gates for the two success criteria this phase owns.

**Approach.** Add to `ci.yml` a job that runs the public-projection snapshot test (S8) and to
`deploy-dev.yml` a Playwright project that runs the guest RSVP flow against the deployed dev
environment with a throttled network profile and asserts the elapsed time (S4). Add a Maestro
flow covering: owner adds a guest by email → copies the link → the link resolves → RSVP →
the owner receives the notification.

**Tests.** These are the tests.

---

### P6-47 — Shared-list E2E, concurrency and access tests

**What to build.** The tests that only exist once two accounts can touch one list, gathered
in one place because each of them is a property of the whole feature rather than of a task.

**The ten that matter, each named because each is a thing the obvious implementation gets
wrong:**

1. **A member cannot change behaviour or capabilities.** Two accounts, one shared list.
   The member `PATCH`es `capabilities.checkable`, gets `403`, and the stored capabilities are
   byte-identical afterwards. Repeat for `behaviour` and `slot`. Then assert the same member
   **can** rename the list, so the test is proving a boundary rather than a blanket denial.
2. **A non-member gets `404`, not `403`.** A third account requests the list, its items, its
   members, and writes an item. Every one is `404`, with a body byte-identical to the `404`
   for a list id that has never existed. `403` would confirm the list exists to somebody with
   no relationship to it.
3. **Leaving removes access and viewer projections, not shared objects.** Count the table's
   items before and after a member with three planned items leaves: the deleted rows are their
   list-index pointer, `MEMBER#`, both reciprocal `LLINK#` rows and three `LNK#<user>#` rows.
   Both `PERSON#` rows, every `ITEM#` and referenced Plan are unchanged; another viewer's
   `LNK#` rows are byte-identical.
4. **Concurrent checks from two members converge.** Two clients, both holding the list, both
   check the same item within the same second, one of them from a queued offline mutation.
   Both requests succeed, no `409` is returned, exactly one item row exists, and its `checked`
   is `true`. Then both uncheck it concurrently and it converges to `false`. The property
   under test is that `checked` is **set, not toggled** — a toggle implementation passes the
   first half of this test and fails the second.
5. **An invited-but-not-signed-up member has no index entry and can read nothing.** Invite an
   address with no account: assert one owner invited `LLINK#`, no active count and zero
   recipient pointers. Create that account with the verified address and assert the pointer,
   reciprocal Person and both active links appear with no prompt or duplicate.
6. **Plan intent is explicit.** `Plan this item` has no default Plan kind or audience. Missing
   `creationTarget`, a Task target, missing audience, and `just_me` with participants each
   return `400` and write no `ACT#`, `PART#`, or `LNK#` row. A watch list and the words
   `Watch Severance` still do not pre-select `watch`.
7. **Private Plans from one item do not cross.** Alice and Ben independently choose
   **Just me** from the same shared item. Both requests succeed, the `ITEM#` row is unchanged,
   and each list-detail response contains only that viewer's Activity id and state. Seed the
   opposite id in the same partition and assert it is filtered before Activity lookup.
8. **Choose people means exactly those people.** Alice selects Chloe and not Ben. Chloe gets
   a `PART#` and `IDX#`; she gets an `LNK#` only if she is also an active list member. Ben gets
   none despite his list membership. A selected guest and selected non-member get Plan access
   but no list pointer.
9. **Links and titles are viewer-local, not global.** No `ListItem` carries
   `linkedActivityId`; replacing Alice's pointer does not change Ben's; renaming the item,
   Alice's Plan, and Ben's Plan in turn never mirrors either of the other titles.
10. **List sharing creates only the chosen relationship.** Alice explicitly adds Sam: each
    gets the other in People and an active `LLINK#`; a second non-owner member gets no Person
    or link for Sam. No `PLINK#`, activity counter, FREQUENT/RECENT rank or list access is
    created from the relationship projection itself.

Plus the ordering property from P3-03, exercised end to end: two members insert an item at
the same position while the other is offline; on reconnect both lists render the two items in
the **same** order on both devices, decided by `(rank, itemId)` and not by arrival time.

**Approach.** Playwright with two browser contexts for 1–4 and 6–10 plus the ordering test; an
integration test for 5, because it spans the Cognito post-confirmation trigger. Add a Maestro
flow covering the human path: owner shares a grocery list, member adds two items, owner
checks one, member sees it checked, member leaves, owner still sees the member's items.

**Tests.** These are the tests. They gate the shared-list half of the phase in the same way
P6-46 gates the invite half.

---

### P6-48 — `DateSuggestion` schema, repository and the 5-per-activity cap

**Files.** `packages/shared/src/types/dateSuggestion.ts`,
`packages/shared/src/schemas/dateSuggestion.ts`,
`services/api/src/repositories/suggestionRepository.ts`.

**What to build.** The stored shape and the writes behind it. The entity is canonical in
[`../02-architecture/data-model.md#43a-datesuggestion`](../02-architecture/data-model.md#43a-datesuggestion)
§4.3a; this task transcribes it and does not redesign it.

**Why it exists.** ADR-037 gave undated plans a home. It did not give them a way to move: the
owner could schedule and everybody else could wait, so Needs a date was a holding area rather
than a planning surface. A suggestion is the smallest thing that fixes that — a participant
can say "how about Thursday?" without being able to decide for everyone (ADR-049).

**The key.** `ACT#<activityId>` / `SUGG#<isoTs>#<suggestionId>`, so suggestions arrive in the
plan-detail `Query` alongside `PART#`, `REM#` and the rest, in creation order, with no second
read and no index.

**The cap is 5 per activity**, enforced with a conditional write against a
`suggestionCount` counter on `ACT#/META`, maintained in the same transaction as the row —
not by counting rows after reading them, which races. Over the cap is `422` with
`This plan already has five suggested dates.` The cap is a shared constant.

**`worksFor` is an array on the suggestion, not a row per person.** It is bounded by the
participant cap, is only ever read with the suggestion itself, and toggling is a single-item
`UpdateItem` using `list_append` / a filtered `SET`. It is an **availability signal, not a
vote and not a like** — the only reaction-shaped thing in the product, and it earns its place
by being the actual coordination signal.

**Edge cases.**

- A suggested date in the past is `validation_failed`. A suggested date more than 18 months
  out is too, on the same rule as `schedule`.
- Two identical `{ date, time }` suggestions from two people are two rows. They are not
  merged: two people independently landing on Thursday is information, and silently collapsing
  it loses the second person's signal.
- The author is implicitly in nothing. `worksFor` starts empty and the author toggles
  themselves in like anyone else, because proposing a date and being free on it are different
  statements — somebody may propose the only date that works for the group and not for
  themselves.
- Deleting the activity deletes the rows in the existing cascade; no new branch is needed.

**Tests.** Zod: a valid suggestion; a past date rejected; a `time` with no `date` impossible
by construction (`date` is required); a `note` over 120 characters rejected. Integration on
DynamoDB Local: five suggestions succeed and the sixth returns `422` with `suggestionCount`
unchanged at 5; two concurrent creates at count 4 result in exactly 5 rows and one `422`, not
6 rows; toggling `worksFor` twice returns to the original array; the plan-detail `Query`
returns the suggestions in creation order.

---

### P6-49 — Suggestion endpoints: list, create, delete, `works` toggle

**Files.** `services/api/src/routes/suggestions.ts`,
`services/api/src/services/suggestions.ts`.

**What to build.** The four routes in
[`../02-architecture/api-contract.md#24b-date-suggestions`](../02-architecture/api-contract.md#24b-date-suggestions)
§2.4b.

| Route | Who | Notes |
| --- | --- | --- |
| `GET /v1/activities/:id/suggestions` | Any participant | Already included in the activity detail response; this exists for polling. |
| `POST /v1/activities/:id/suggestions` | Any participant | `{ date, time?, note? }`. Max 5 → `422`. |
| `DELETE /v1/activities/:id/suggestions/:suggestionId` | **Author or owner** | Anyone else is `404`, not `403` — a `403` would confirm somebody else's suggestion exists at that id. |
| `POST /v1/activities/:id/suggestions/:suggestionId/works` | Any participant | Toggles the caller in `worksFor`. Idempotent per state, not per call. |

**Guests cannot suggest.** There is no public route and the public projection carries no
suggestions (P6-18). A guest reads and RSVPs; that is the whole guest contract.

Adding, withdrawing or marking a suggestion **bumps `lastActivityAt`**, so a plan people are
actively trying to schedule floats to the top of Needs a date. It does **not** bump
`updatedAt`, so an owner with an open edit sheet keeps a valid `If-Match` — the same rule as
an RSVP (P2-06, ADR-039). Getting this backwards produces a `409` on the owner's edit because
somebody proposed a Thursday.

**Notifications.** A new suggestion notifies **the owner only**, under `plan_activity`, which
is off by default. Marking one as workable notifies nobody. Needs a date never nudges
(ADR-037), and a plan with four participants proposing dates must not become four pushes per
person. Every suggestion action writes a system update to the feed, which is where the group
sees it.

**Edge cases.**

- On an activity that already has a date, `POST` returns `409` with
  `This plan already has a date.` Suggesting against a scheduled plan is a reschedule request,
  which is a conversation for the updates feed.
- A declined participant may not suggest. They left the plan in every sense that matters.
- Deleting a suggestion that has `worksFor` entries is allowed and silent. The author
  withdrawing a date is not something to warn about.
- The `works` toggle on a suggestion the caller has already marked removes them. Two clients
  racing converge, because the write sets membership rather than flipping it — the same rule
  as `checked` on a list item (ADR-044).

**Tests.** Integration: a participant creates a suggestion and it appears in the owner's
detail response; a sixth returns `422`; the author deletes their own (`204`) and a third
participant's delete of it returns `404` while the owner's returns `204`; `works` toggles on
and off and the array converges under two concurrent calls; `POST` on a dated activity
returns `409`; a stranger gets `404` on all four; `lastActivityAt` moves and `updatedAt` does
not, with an `If-Match` captured before the suggestion still returning `200` afterwards.

---

### P6-50 — `schedule { fromSuggestionId }` and suggestion cleanup

**Files.** `services/api/src/services/scheduleService.ts` (extend P6-15).

**What to build.** The one action only the owner may take.

**Approach.** `POST /v1/activities/:id/schedule` accepts `{ fromSuggestionId }` as an
alternative to `{ date, time?, … }`. The service loads the suggestion, copies its `date` and
`time` onto the schedule, and then runs **the ordinary scheduling path unchanged** — the
bucket move from `#P` to `#S`, the index-entry rewrite for every participating user, the
`icsSequence` bump, the RSVP reset, the system update and the notifications (P6-15). There is
no second scheduling implementation and no branch inside the reset.

**Only the owner may schedule.** A participant gets `403`. This is the whole point of the
feature: proposing is open, deciding is not (ADR-049). It is one row in the P6-28 matrix, not
a check in this handler.

**Every `SUGG#` row is deleted in the same transaction as the schedule write.** The question
they answered has been answered; a plan detail carrying "we also considered Thursday" forever
is a second timeline beside the updates feed. The system update records which suggestion was
chosen and who proposed it, so the history survives in the one place history lives.

> **Decision:** scheduling from a suggestion **still resets every RSVP**, including the RSVPs
> of people who marked that very suggestion as workable. `worksFor` is availability — "I
> could do Thursday" — and not consent to attend. Treating it as consent would quietly make the
> reset skippable by the one route most likely to be used, which is exactly the consent
> problem ADR-040 exists to prevent. The client says so: `Thursday works for Alice and Ben —
> they'll still be asked to confirm.`

**Edge cases.**

- An unknown or already-deleted `fromSuggestionId` is `404`. Two owners cannot race here —
  there is one owner — but an owner with two devices can, and the second call finds no
  suggestion and no `#P` bucket.
- `fromSuggestionId` together with an explicit `date` is `validation_failed`. Two sources for
  one field is a bug in the caller, not something to resolve by precedence.
- Unscheduling afterwards does **not** restore the deleted suggestions. They are gone, and the
  plan returns to Needs a date empty, which is honest: the group agreed on a date and then
  the owner changed their mind, so the old proposals are stale.
- A suggestion whose date has passed by the time the owner schedules from it is
  `validation_failed`, with the reason named.

**Tests.** Integration: the owner schedules from a suggestion, and the resulting activity is
byte-identical to one scheduled with the same `{ date, time }` typed in directly, except for
the system update's wording — asserted by running both paths against two fixtures and
comparing; every `SUGG#` row is gone, counted before and after; **a participant's
`POST .../schedule { fromSuggestionId }` returns `403`, no suggestion is deleted and no
schedule is written**; `rsvpReset: true` comes back even when every participant had marked
that suggestion as workable; `fromSuggestionId` plus `date` is `400`.

---

### P6-51 — Date suggestions on plan detail and the Needs-a-date row

**Files.** `apps/mobile/src/features/plans/components/{SuggestedDates.tsx,
SuggestDateSheet.tsx}`, `apps/mobile/src/features/plans/components/NeedsDateRow.tsx`
(extend, P3-35), `apps/mobile/src/features/plans/PlanDetail.tsx` (extend, P3-36).

**What to build.** The two surfaces where a suggestion is made and seen.

**On plan detail**, a `SUGGESTED DATES` section that appears **only while the plan has no
date**, between the when/where block and PEOPLE. It renders each suggestion as a row: the
date and time, the proposer's name, the optional note, the `worksFor` faces, and a
`Works for me` toggle that is filled when the caller is in the array. The section's footer is
`Suggest a date`, which opens a sheet with a date picker, an optional time and an optional
note, and closes on save.

**The owner sees one more control per row: `Schedule this`.** A participant does not. It is
absent from their render tree, not disabled — a disabled control invites a tap and then
explains why not, which is a worse way to say "this is not yours to decide". Tapping it shows
the standard reschedule confirmation with the RSVP-reset line from P6-15, naming how many
people will be asked again, and then calls `POST .../schedule { fromSuggestionId }`.

At five suggestions the footer reads `Five suggested dates — that's the limit` and the sheet
does not open. Refusing inline beats a `422` the user has to read.

**On the Needs-a-date row** (P3-35), the summary line gains the suggestion state after the
RSVP summary, in the same sentence style:

```
Alice interested · Ben hasn't replied
2 dates suggested · Thu works for Alice
```

The second line is absent when there are no suggestions, which is the common case, so a row
for a plan nobody has moved on looks exactly as it does today. Tapping the row opens detail;
it never mutates, and there is no suggest affordance on the row itself (U5, the tap-a-row
rule).

**Edge cases.**

- The section disappears the moment a date lands, because the suggestions were deleted
  server-side (P6-50). The client does not hide it locally; it renders what it is given.
- `Works for me` is optimistic with the standard undo-less immediate write. It is reversible
  by tapping again, so it needs no toast.
- A suggestion made while the plan detail is open arrives on the next refetch. There is no
  live subscription and no polling loop on this screen; `GET .../suggestions` exists for a
  pull-to-refresh, not a timer.
- Empty state: a plan with no suggestions shows the footer alone, with no illustration and no
  encouragement copy. Needs a date does not nudge, and that includes not nagging somebody to
  propose a date.
- The guest page has none of this (P6-45).

**Tests.** Render tests: the section is absent on a dated plan and present on an undated one;
`Schedule this` renders for the owner and is **absent** from a participant's tree, asserted on
the tree rather than on a `disabled` prop; the footer refuses at five. A test that the
Needs-a-date row omits the second line with zero suggestions and renders it with two.
Playwright: participant suggests a date, owner sees it with the proposer's name, owner taps
`Schedule this`, confirms, and the section disappears while the date appears in the
when/where block.

---

### P6-52 — Date-suggestion tests: authorisation, cap, cleanup, guest refusal

**What to build.** The gates for the feature, gathered in one place because each is a property
of the whole feature rather than of a task — the same shape as P6-46 and P6-47.

**The five that matter:**

1. **A non-owner cannot schedule.** A participant `POST`s
   `.../schedule { fromSuggestionId }` for a suggestion **they themselves created** and gets
   `403`. Afterwards the activity is still undated, still in the `#P` bucket, and every
   `SUGG#` row is still present. Proposing gives you no claim on deciding, and the test
   proves it by using the strongest case for the opposite.
2. **Scheduling clears suggestions.** The owner schedules from one of five. Count the
   `ACT#<id>` partition before and after: zero `SUGG#` rows remain, the counter on `META`
   reads 0, and unscheduling the plan afterwards does **not** bring any back.
3. **The cap holds under concurrency.** Two participants `POST` simultaneously at four
   suggestions. Exactly five rows exist and exactly one `422` was returned.
4. **A guest cannot suggest, and cannot see that anyone did.** With five suggestions on an
   undated plan, `GET /public/v1/invites/:token` contains no suggestion, no proposer name and
   no `worksFor`, asserted against the checked-in projection snapshot; there is no public
   route that accepts one.
5. **The RSVP reset is not skipped.** Every participant marks a suggestion as workable; the
   owner schedules from it; every `PART#` row reads `pending` and the response carries
   `rsvpReset: true`. Availability is not consent, and this is the test that stops somebody
   optimising the reset away for the path where it looks unnecessary.

**Approach.** Integration tests for 1, 2, 3 and 5; the projection snapshot for 4, extending
the P6-18 fixture rather than adding a second one. Add one Maestro flow covering the human
path: two accounts, one undated plan, participant suggests two dates, owner picks one, both
see the date and both see a pending RSVP.

**Tests.** These are the tests.

---

## Acceptance criteria

1. Adding the first participant to a private Plan of any `PlanType` flips `visibility` to
   `shared`, and removing the last participant leaves it `shared`. A Task participant add is
   `400`, writes nothing, and never changes `objectKind` or `type`.
2. An app user added to a plan receives a push, an inbox entry, and the plan on their Today
   with `rsvp: 'pending'` and an inline three-button RSVP control, within one agenda refresh.
3. Setting `declined` removes the plan from the invitee's Today and agenda, leaves a durable
   read-only row in Plans under the plan's date with a `Rejoin` action, and rejoining — from
   that row or from the inbox entry while it lives — restores the full entry with the
   correct GSI1 sort key.
4. A guest with an email receives one SES message containing a working link and an opt-out
   line; the opt-out link revokes their token and stops all further mail about that plan.
5. `GET /public/v1/invites/:token` returns exactly the keys in the P6-10 schema. The
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
21. Exactly four SES send functions exist — invitation, plan changed, plan cancelled, list
    invitation. A test enumerating the email service's exports fails if a fifth appears, and
    the `list-invitation` body contains no item title and no token.
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
27. `expo-contacts` is imported in exactly one file, which uses `presentContactPickerAsync`
    and no other export. A test enumerating the app's imports fails if a second importer
    appears or if `getContactsAsync`, `getContactByIdAsync` or either permissions function is
    referenced anywhere.
28. Picking a contact whose email already belongs to a `Person` offers the existing person and
    writes no second row; choosing `Use <name>` sends `{ personId }`. Picking a contact with
    two email addresses asks which one and stores only that one.
29. The iOS build requests no contacts permission at any point in the add flow, ships no
    `NSContactsUsageDescription`, and stores no contact data other than the picked person's
    name, email and phone. `⊕ Choose from Contacts` is absent from the web render tree, and a
    person can still be added on web by typing.
30. Adding a registered member to a list writes at most seven items in one transaction:
    member, one access pointer, owner/member People when absent, two active `LLINK#` rows and
    the counter. It creates no `PLINK#` or activity-counter write, and renames remain **one
    write** regardless of member count.
31. A `member` gets `403` on `behaviour`, `capabilities`, `slot`, member management and
    delete, writes nothing on any of them, and **can** rename the list, edit, check, reorder
    and delete items, and leave.
32. A non-member gets `404` — never `403` — on every list-scoped route, with a body identical
    to the `404` for a list id that has never existed.
33. Leaving a list transactionally deletes the leaver's list-index pointer, `MEMBER#` and
    both reciprocal `LLINK#` rows, then removes every `LNK#<leaver>#` row. Both People, every
    item and every referenced Plan survive; another viewer's links are unchanged and
    `itemCount` is unchanged.
34. Two members checking the same item concurrently both succeed with no `409`, and the item
    converges to `checked: true`; both unchecking converges to `false`. No code path writes
    `SET checked = NOT checked`.
35. Two members inserting at the same position produce two items whose order is identical on
    both devices, decided by `(rank, itemId)`.
36. An add that would make the total 21 people is refused with `422` and writes nothing. From
    a new private list, the owner may select at most 19 distinct new people; the share sheet
    enforces `memberCount + distinctNewSelections <= 20` without reaching the network.
37. An invited member with no account has a `MEMBER#` row and owner invited `LLINK#`, **zero**
    recipient index entries, no active shared-list count, and gets `404` from every list
    route. Verified signup creates the reciprocal Person, pointer and member active `LLINK#`,
    activates the owner link, and the list appears with no prompt or duplicate. Withdrawing
    first removes the invited link, leaves the Person-level email locator, and grants nothing
    on later signup.
38. Giving a date to a plan resets every non-declined participant's `rsvp` to `pending`,
    sets `rsvpForDate`, leaves the owner's row and every `declined` row (app user or guest)
    untouched, writes one system update, sends one
    notification per non-declined person, and returns `rsvpReset: true`. Changing only the
    time on the same date keeps every response and returns `rsvpReset: false`.
39. A 46-participant plan takes the two-phase reset path, and a read taken between the phases
    returns `pending` for every participant, never a stale `going`.
40. The RSVP enum has exactly four members. `interested` appears in no type, no schema and no
    stored value — asserted against a checked-in literal array and a grep. The same
    participant renders `Interested` before a date exists and `Going` after, with the stored
    value byte-identical.
41. Creating a list from a shared plan begins with the full style catalogue unselected and
    requires the exact user-selected `templateKey`. The Plan's kind and title select nothing.
    With the share row untouched it writes the list and **zero** `MEMBER#` rows; that row is
    unticked on every template and absent for a private plan.
42. `GET /public/v1/invites/:token` for an **undated** plan returns `dateStatus: 'undecided'`
    with null date fields, and the page renders `The date is being decided` with
    `Interested · Maybe · Pass` and no add-to-calendar affordance. The same token after the
    owner schedules renders the date with `Going · Maybe · Decline` and a `pending` state, not
    the guest's earlier answer.
43. A guest who answered `Interested` on an undated plan receives exactly one `plan-changed`
    email when a date lands, whose rendered body contains the date and does not contain the
    phrase about the date being decided, and whose `PART#` row reads `pending`.
44. Adding a participant whose `defaultReminderOffset` is `-120` to a plan whose owner has
    `-15` leaves the partition with two `REM#` rows under two different `userId`s; each user's
    `GET .../reminders` returns exactly their own; the owner's row is byte-identical to before
    the add. A separate case proves an explicit `0` writes an At-the-time row while an
    absent/null default writes none.
45. A participant's `POST /v1/activities/:id/complete` returns `403` and the `ACT#<id>`
    partition has the same item count and the same `META.updatedAt` afterwards.
46. A participant may `POST` a date suggestion (`201`) and may not schedule from it: their
    `POST .../schedule { fromSuggestionId }` returns `403`, the activity is still undated and
    still in `#P`, and every suggestion survives.
47. The sixth suggestion on one activity returns `422` and writes nothing; two concurrent
    creates at four produce exactly five rows and one `422`.
48. Scheduling from a suggestion deletes **every** `SUGG#` row on that activity, resets every
    participant's RSVP to `pending` — including participants who had marked that suggestion as
    workable — and returns `rsvpReset: true`. Unscheduling afterwards restores no suggestion.
49. The public projection for a plan with five suggestions contains no suggestion, no
    proposer name and no `worksFor`, asserted against the snapshot; there is no public route
    that accepts a suggestion.
50. `Schedule this` is absent from a participant's rendered plan detail — asserted on the
    render tree, not on a `disabled` prop — and present for the owner.
51. `Plan this item` on a shared list requires a user-selected `PlanType` and one explicit
    audience choice. Omitting either, using a Task target, or sending participants with
    `just_me` returns `400` and writes nothing. No title, template, behaviour, or list member
    selects either value.
52. Alice and Ben may each create a **Just me** Plan from the same shared ListItem. The item
    has no `linkedActivityId` and remains byte-identical; each list-detail response exposes
    only its caller's `LNK#<viewer>#<item>` Activity id and state, filtered before lookup.
53. **Choose people** creates participants only for the submitted people. Only selected
    registered participants who are active members of the source list receive `LNK#` rows;
    unselected members, guests, and selected non-members receive none. Membership alone never
    creates Plan access.
54. Item and Plan titles are copied once and then independent. Renaming a shared item cannot
    rename any member's private Plan, and deleting one Plan removes only matching viewer
    pointers while every ListItem and newer pointer survives.
55. Deleting a shared list removes every member pointer, invited/active `LLINK#` and `LNK#`
    projection. Every owner-scoped Person and every referenced Activity survives.

## Out of scope for this phase

Each of these is tempting here and belongs elsewhere.

| Not in Phase 6 | Where it belongs |
| --- | --- |
| Expenses, splits, balances, settlement, the plan owes summary | Phase 7 |
| The People page, the full Person view, FREQUENT ranking, `POST /v1/people`, merge | Phase 7 |
| DynamoDB Streams — the stream is not enabled until Phase 7 | Phase 7 |
| Two-way calendar sync, reading the user's calendar, subscribing to a feed URL | Not planned ([`../01-product/overview.md`](../01-product/overview.md) §6) |
| `METHOD:REQUEST`, `ATTENDEE` lines, or an email-based RSVP reply channel | Never |
| A recurring-series `.ics` export with `RRULE` and `VTIMEZONE` | Not planned |
| Guests reading anything beyond the public projection — no guest expense view, no guest feed, **no guest date suggestions** | [`../01-product/expenses.md`](../01-product/expenses.md) §6.6, ADR-049 |
| A **date poll**: more than five suggestions, a deadline, a quorum, an automatic winner, or a per-person yes/no/maybe grid | Not in v1. Five is a nudge toward a date; a poll needs closing rules and a nagging cadence, and Needs a date nudges nobody (ADR-037, ADR-049) |
| **Per-participant completion**, an `attendedBy` field, or an `OCC#<date>#<userId>` key | Deferred with its full cost — [`../00-open-decisions.md`](../00-open-decisions.md) item 31, ADR-048 |
| **`schedule.endDate`** or any multi-day range on a plan, in the app, on the guest page, in the emails or in `.ics` | Not in v1 (ADR-050). A trip is one activity on its start date |
| One user setting, seeing or removing **another user's** reminder | Never. A reminder belongs to a person (ADR-047) |
| A **read-only list viewer** role, a public read-only list link, or any list surface a stranger can reach. A list has no public projection at all in v1. | Deferred — [`../00-open-decisions.md`](../00-open-decisions.md) |
| Guest (non-app-user) list **editing**. Membership is app users only, because every item mutation needs an identity to attribute it to. | Not in v1 |
| Ownership transfer of a list, or a third role between `owner` and `member` | Not in v1 |
| Per-item author attribution, "added by Alice" lines, or an item-level activity feed | Not in v1 |
| Shared watch progress. Two people watching a show keep separate `season`/`episode` even on a shared list. | Deferred ([`../00-open-decisions.md`](../00-open-decisions.md) item 23) |
| Offline behaviour for shared lists — which mutations queue, and what happens when a shared list changes under a cached copy | Phase 9 (P9-06 to P9-08) |
| Bulk member add, or a members endpoint that takes an array | Not in v1 (P6-29) |
| Comments, threads, reactions, direct messages between people | Never ([`../01-product/sharing-and-people.md`](../01-product/sharing-and-people.md) §7) |
| Reading, enumerating, uploading or storing the device address book; contact-list import; address-book sync; matching contacts against other app users | Never. The OS contact **picker** (P6-35) is in this phase and is a different thing: one contact, chosen by the user, out of process. |
| Web push for invitations | Not in v1 ([`../01-product/notifications.md`](../01-product/notifications.md) §6.2) |
| Participants adding attachments | Not in v1 |
| Marketing email, digests, re-engagement sends, or any **fifth** SES template | Never |
| AWS WAF on the public surface | Only on observed abuse (ADR-022) |

## Risks and gotchas

| # | Risk | Mitigation |
| --- | --- | --- |
| 1 | **SES production access takes days and blocks the end of the phase.** | Submit P6-02 on day one. Everything else is built against the dev sandbox with a verified recipient. Do not sequence it late. |
| 2 | **DKIM CNAMEs propagate slowly.** Requesting production access before DKIM shows `SUCCESS` invites a rejection. | Poll `get-email-identity` and gate P6-02 on it. |
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
| 14 | **Shareable links and `localStorage`-based guest identity** produce duplicate participants when a guest opens the link on a second device. | Documented and accepted: the owner sees two rows and can merge them in Phase 7. Do not build device fingerprinting. |
| 15 | **The 50-participant cap interacts with a shareable link** — the 51st stranger gets a hard error on a page that otherwise never fails. | Explicit copy (`This plan is full.`) and a test; the owner sees the cap on the plan detail before it is reached. |
| 16 | **The contact picker quietly grows into a contact sync.** `expo-contacts` also exports `getContactsAsync`; one call to it turns a permissionless flow into a permission prompt, an App Store privacy-label change, and third-party PII at rest. | One importing file, a `dependency-cruiser` rule, a lint ban on every other export, and acceptance criteria 27 and 29. Adding the read API is a product decision, not a refactor. |
| 17 | **The picker fills the address book with duplicates.** A user who picks the same contact twice, or picks someone they typed in last month, gets two `Person` rows and two halves of a balance. | P6-36's match runs before any write; the merge route is Phase 7. `Add as a new person` remains available on purpose, because two people do share a name. |
| 18 | **`checked` is implemented as a toggle.** `SET checked = NOT checked` reads correctly in one client and produces two people un-doing each other in two. It also breaks the offline queue, where the same intent may be delivered twice. | The canonical rule is *set, not toggle* (`data-model.md` §4.6). Acceptance criterion 34 checks concurrently **and** unchecks concurrently — a toggle passes the first half and fails the second — plus a grep test for `NOT checked` and for a client-side `!item.checked` in a mutation payload. |
| 19 | **`If-Match` is added to list item writes** "for consistency with activities". | Every checkbox in a shopping list starts returning spurious `409`s and the offline queue parks half a shop. Item writes carry no `If-Match` by design; list-*level* edits do. Asserted by a route test that an item `PATCH` with a stale `If-Match` still returns `200`. |
| 20 | **A non-member gets `403` instead of `404`**, because `403` is what the code naturally produces when a role check fails. | It confirms the list exists to somebody with no relationship to it. `assertListAccess` returns `404` when the **pointer** is missing and only ever returns `403` when the pointer exists with the wrong role — two distinct failure paths, both in the matrix test (P6-32, criterion 32). |
| 21 | **The invited member is given an index entry** "so the query is uniform", or a placeholder user id is invented for them. | Both make an account-less person addressable in a partition that does not exist, and the first grants access before signup. The rule is: no `userId`, no pointer, `404` everywhere, until the verified email arrives (P6-29, P6-27, criterion 37). |
| 22 | **The RSVP reset is skipped, or applied to the owner**, or a new `interested` enum value is introduced so the label can be stored. | A date landing without a reset claims consent nobody gave; a stored `interested` forces a migration on the exact event that changes the word. P6-15 and P6-40, criteria 38 and 40, with the enum compared to a literal array. |
| 23 | **The reset transaction exceeds 100 items** at the participant cap and is discovered at 50 people rather than in review. | The budget is computed in P6-15 (103 items at the cap), the threshold is a shared constant, and the two-phase path is tested at 45 and 46 with an assertion that the intermediate read never shows a stale response. |
| 24 | **A denormalised field creeps onto the list pointer** — a title for the Lists tab, a count for a badge. | Renaming a shared list becomes 20 writes and a ticked checkbox becomes a fan-out. The pointer's attribute set is compared to a literal list in Phase 3 (criterion 27) and the property is restated in criterion 30. |
| 25 | **The plan → list share row is pre-ticked** for "obviously shared" templates like groceries. | The exception grows, and the first time it is wrong it silently shares a packing list. Unticked on every template, asserted by a table-driven test over the whole catalogue (P6-44, criterion 41). |
| 26 | **Marking a suggestion as workable is treated as consent**, so the RSVP reset is skipped when the owner schedules from a suggestion everybody said worked. | It is the most tempting optimisation in the feature and it defeats the rule on the exact path that will be used most. `worksFor` says "I could do Thursday", not "I am coming on Thursday" — the second is a different question and it is asked separately. Criterion 48 schedules from a suggestion every participant marked and asserts every row reads `pending`. ADR-049. |
| 27 | **An `LLINK#` is mistaken for list access or left dangling.** | `assertListAccess` accepts only the exact `USER#/LIST#` pointer; add/remove/delete tests assert both reciprocal link lifecycles and Person retention. |
| 28 | **Removing one pending list invite deletes the Person-level `GUESTEMAIL#`.** | The invite removes only its `MEMBER#` and invited `LLINK#`; the locator survives until Person/email deletion or verified linking, with a test covering another relationship for the same guest. |
| 29 | **A participant can schedule**, because the button is right there on the suggestion they wrote and disabling it feels unfriendly. | One person then picks the date for a plan somebody else owns, firing every participant's index rewrite and RSVP reset. `Schedule this` is **absent** from a participant's render tree rather than disabled (P6-51), the rule is a row in the P6-28 matrix, and criterion 46 uses the strongest case for the opposite — the participant who proposed the date. |
| 30 | **Suggestions are kept after scheduling** "for history", or restored on unscheduling. | The plan detail grows a permanent record of dates that did not happen, beside the updates feed which is where history lives. They are deleted in the scheduling transaction and criterion 48 counts the partition. The chosen suggestion and its proposer survive in the system update. |
| 31 | **The guest page keeps one vocabulary** because switching it looks like duplicated copy, or the undated invite is refused outright as "nothing to invite anyone to". | Asking a stranger "are you coming?" about a plan with no date is incoherent, and they are the person least able to work out what it means. An undated plan has a working invite page; what it lacks is an exportable event, which is a separate rule about `.ics`. The words come from `rsvpLabel` on both surfaces, asserted by a cross-surface test (P6-40, P6-45, criterion 42). |
| 32 | **A joiner inherits the creator's reminder**, because the reminders are right there on the activity being copied from. | Alice, who lives next door, gets the owner's "leave in 15 minutes". `Activity` has no `reminders[]`; a joiner's row comes from **their own** `defaultReminderOffset` (P6-13) and `CreateActivityInput.reminders` wrote for the creator alone (P1-11). Criterion 44 asserts two rows, two users, two offsets. ADR-047. |
| 33 | **A shared ListItem gets one `linkedActivityId`, or list membership is copied into Plan participation.** | One member's private schedule then leaks to everyone, and two members planning the same item overwrite each other. P6-11, P6-29, P6-43 and criteria 51–54 require an explicit `PlanType`, an explicit **Just me / Choose people** audience, and one `LNK#<viewer>#<item>` projection per authorised viewer. The list-detail repository filters by viewer before Activity lookup. |
| 34 | **A new-list or Plan-this-item sheet infers a template, destination, type, or audience from words or context.** | The app silently answers the organising decision it is supposed to ask. The template catalogue and Plan-kind chooser start unselected, request schemas reject omission, and the same ambiguous title is table-tested through different explicit targets. P6-11, P6-43, P6-44. |
