# Phase 4 — Ship v1 (private beta)

## Goal

At the end of this phase other people are using the app. The web build serves from
`ordinarydays.app` behind CloudFront with a real certificate and a real Content Security
Policy. An EAS pipeline produces signed iOS builds that reach TestFlight, and testers who
are not the founder install them. Reminders are no longer local-only: EventBridge Scheduler
fires a reminder Lambda that delivers a push through Expo, honouring quiet hours, and the
permission prompt is asked at the moment it first makes sense rather than at first launch.
The App Store requirements that are enforced at review — Sign in with Apple, in-app account
deletion, accurate privacy labels, a reachable privacy policy — are all satisfied and
verified, not assumed. A server-side kill switch can force an upgrade when a shipped build
is genuinely broken. Performance and accessibility have been measured against the numbers in
[`../01-product/overview.md`](../01-product/overview.md) §7 rather than eyeballed.

## Prerequisites

| # | Item | Notes |
| --- | --- | --- |
| 1 | Phases 0–3 complete and their acceptance criteria passing | |
| 2 | **Apple Developer Program membership active** | $99/yr, enrolled during Phase 1. Individual enrolment can take days; organisation enrolment with a D-U-N-S number can take weeks. If it is not active on day one of this phase, the phase cannot finish. |
| 3 | A privacy policy and a support page written | Drafted from [`../02-architecture/security-privacy.md`](../02-architecture/security-privacy.md) §8.3. Both need public URLs before the App Store Connect record can be completed. |
| 4 | A dev Expo account and `EXPO_TOKEN` in GitHub secrets | Free plan is sufficient; see the queue caveat in [`../02-architecture/cost-model.md`](../02-architecture/cost-model.md) §3.3. |
| 5 | An `AASA` / universal-links decision | Deep links from push open specific screens; universal links are optional in v1 and the custom scheme is sufficient. |

## Deliverables

- [ ] `ordinarydays.app` serving the prod web build over CloudFront with the full CSP,
      HSTS and the response-headers policy.
- [ ] `SchedulerStack` deployed: schedule group, reminder Lambda, and the API's role to
      create and delete schedules.
- [ ] Server-side reminder scheduling on every write that touches `schedule`, `recurrence`
      or `reminders`, with the next-two-occurrences bound for series.
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
| P4-01 | Prod web hosting and the custom domain | infra | P0-19 | no | M |
| P4-02 | Content Security Policy and response headers | infra | P4-01 | no | M |
| P4-03 | Confirm Apple Developer Program enrolment and Team ID | ops | — | yes | S |
| P4-04 | Bundle identifiers, app icons, splash, `app.config.ts` for prod | mobile | P4-03 | no | M |
| P4-05 | EAS project, credentials, `eas.json` profiles | mobile | P4-04 | no | M |
| P4-06 | `mobile.yml`: EAS build and submit in CI | ci | P4-05 | no | M |
| P4-07 | `SchedulerStack`: group, reminder Lambda, roles | infra | P0-21 | no | L |
| P4-08 | The reminder Lambda | api | P4-07 | no | L |
| P4-09 | Reminder scheduling on API write paths | api | P4-08, P2-14 | no | L |
| P4-10 | Quiet hours, held notifications, the digest | api | P4-08 | no | M |
| P4-11 | Device registration and the Expo push token lifecycle | mobile | P1-11 | no | M |
| P4-12 | The permission pre-prompt and deferred system prompt | mobile | P4-11 | no | M |
| P4-13 | Notification preferences endpoints and screen | api/mobile | P1-10 | yes | M |
| P4-14 | The in-app inbox | api/mobile | P4-13 | no | L |
| P4-15 | Deep links from push to the exact screen | mobile | P4-11 | no | M |
| P4-16 | `DELETE /v1/me`: soft delete and immediate effects | api | P1-10 | no | L |
| P4-17 | The 30-day purge job | api/infra | P4-16 | no | M |
| P4-18 | Account deletion UI with re-authentication | mobile | P4-16 | no | M |
| P4-19 | Data export | api | P4-16 | yes | M |
| P4-20 | Privacy policy and support pages | web | — | yes | S |
| P4-21 | `426 upgrade_required` kill switch, server side | api | P1-05 | yes | M |
| P4-22 | The blocking upgrade screen, client side | mobile | P4-21 | no | S |
| P4-23 | App Store Connect app record | ops | P4-04 | no | M |
| P4-24 | Privacy nutrition labels | ops | P4-23 | no | M |
| P4-25 | Screenshots at the required sizes | ops | P4-05 | no | M |
| P4-26 | Review notes and the demo account | ops | P4-23 | no | S |
| P4-27 | TestFlight: internal, then external | ops | P4-06, P4-23 | no | M |
| P4-28 | Performance pass and the cold-start budget check | api/mobile | P2-09 | no | L |
| P4-29 | Accessibility pass | mobile | P2-20, P3-26 | no | L |
| P4-30 | Prod data protections: PITR, deletion protection, backup drill | infra | P0-15 | yes | S |
| P4-31 | Prod alarms, dashboard, and the on-call runbook | infra | P0-20, P4-08 | no | M |
| P4-32 | Rehearse a rollback | ops | P4-31 | no | S |
| P4-33 | Prod smoke tests and the release checklist | ci | P0-32 | no | M |
| P4-34 | Beta onboarding and the feedback channel | ops | P4-27 | yes | S |

P4-03, P4-20, P4-30 and P4-34 are mechanical; follow the referenced sections.

---

### P4-02 — Content Security Policy and response headers

**Files.** `infra/lib/stacks/web-stack.ts` (response-headers policy).

**Approach.** Promote the Phase 0 report-only CSP to enforcing, using the policy in
[`../02-architecture/security-privacy.md`](../02-architecture/security-privacy.md) §4.3.
Ship it report-only on prod for **one week** first and read the reports; an enforcing CSP
that blocks the app's own bundle is a full outage with no server error to alarm on.

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

### P4-04 — Bundle identifiers, icons, and prod app config

**Approach.** The identifiers are already set by profile in `app.config.ts`
([`../02-architecture/infrastructure.md`](../02-architecture/infrastructure.md) §6.4):

| Profile | Bundle identifier | App name | URL scheme |
| --- | --- | --- | --- |
| `prod` | `app.ordinarydays.ios` | `Ordinary Days` | `ordinarydays` |
| `dev` | `app.ordinarydays.ios.dev` | `Ordinary Days (dev)` | `ordinarydays-dev` |
| `local` | `app.ordinarydays.ios.local` | `Ordinary Days (local)` | `ordinarydays-local` |

`app.ordinarydays.ios` must match the App ID registered for Sign in with Apple in Phase 1
(P1-24) exactly. A mismatch breaks Apple sign-in in the production build only, which is the
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

### P4-05 — EAS project, credentials, `eas.json`

**Approach.** `eas init` links the project. `eas credentials` generates and stores the
distribution certificate and provisioning profile on EAS's servers, so the founder never
manages a keychain. The push key (APNs) is also generated here — Expo Push needs it to
deliver to production builds.

`eas.json` profiles as in
[`../02-architecture/infrastructure.md`](../02-architecture/infrastructure.md) §6.4:
`development` (dev client, internal), `preview` (internal, dev profile), `production`
(prod profile, `autoIncrement`). `submit.production.ios.ascAppId` is filled after P4-23.

**Edge cases.** On the free EAS plan builds sit in a low-priority queue that can be hours
long. Plan the first production build for a day when waiting is acceptable, and never make
an infrastructure deploy depend on a build completing.

**Tests.** `eas build --platform ios --profile preview` produces an installable build;
install it on a device from the QR code and confirm it points at the dev API.

---

### P4-07 / P4-08 — `SchedulerStack` and the reminder Lambda

**Files.** `infra/lib/stacks/scheduler-stack.ts`,
`services/api/src/reminder/index.ts`.

**Approach.** A schedule group `od-reminders-{env}`. The API's execution role gets
`scheduler:CreateSchedule` and `scheduler:DeleteSchedule` scoped to that group, plus
`iam:PassRole` on a dedicated invocation role that may invoke only the reminder function.

Schedules are **one-time** (`at(...)`), with `ActionAfterCompletion: DELETE` so fired
schedules clean themselves up and the account quota is never approached, and
`FlexibleTimeWindow: OFF` — a reminder that fires ten minutes late is a broken reminder.

Schedule names are deterministic: `rem_<activityId>_<reminderId>_<occurrenceDate>`, so a
delete never needs a lookup.

The reminder Lambda: 512 MB, 30 s timeout, reserved concurrency 5. On invocation it reads
the activity and the user's `DEVICE#` rows (access pattern 15), re-derives the fire time
from `date` + `time` + `timezone` to confirm it is still correct, applies the quiet-hours
rule, sends through Expo Push, and — for a recurring series — schedules the reminder for
occurrence *n+2*.

**Edge cases.**

- **Recurring series schedule only the next two occurrences' reminders at a time.** The
  Lambda schedules the following one after each fires. This keeps the schedule count bounded
  regardless of how long a series runs.
- A reminder more than **30 minutes** late at delivery is dropped rather than shown. A 6 PM
  reminder arriving at 9 PM is worse than nothing.
- A skipped or completed occurrence fires no reminder; if it was resolved after the schedule
  was created, the schedule is cancelled on the resolving write.
- If the user has no registered device, the reminder is skipped. Pure reminders write **no**
  inbox entry — Today already shows them.
- Multiple reminders on one activity fire independently and are not coalesced.
- Expo Push receipts must be checked: a `DeviceNotRegistered` error deletes that `DEVICE#`
  row. Skipping this leaks pushes to devices that no longer exist and eventually gets the
  token throttled.

**Tests.** Unit on the fire-time derivation across a DST boundary using the same
`toUtcInstant` from Phase 2, asserting the reminder scheduler and the agenda agree at the
boundary. Integration with `aws-sdk-client-mock` asserting create/delete calls with the
deterministic name. An end-to-end manual test on a device: set a reminder two minutes out,
background the app, receive the push, tap it, land on the right screen.

---

### P4-10 — Quiet hours, held notifications, the digest

**Approach.** Default window 22:00–07:00 local, enabled by default. The behaviour table in
[`../01-product/notifications.md`](../01-product/notifications.md) §4 is normative, and the
two exceptions are the interesting part:

1. A **reminder for an activity that is itself inside the window** is delivered. A 6 AM
   flight reminder is exactly what quiet hours must not suppress.
2. A **plan cancellation for a plan starting within the next 12 hours** is delivered.

Everything else is held to the window's end. More than three held items become one
`held_digest` push. Inbox entries are written at their **original** time regardless of
holding, so the inbox reflects when things actually happened.

**Tests.** Table-driven unit tests over the §4 matrix with a frozen clock, including a
reminder inside the window for an activity inside the window (delivered) and one for an
activity outside it (held).

---

### P4-12 — The permission pre-prompt

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

### P4-16 / P4-17 / P4-18 — Account deletion

**This is enforced at App Store review.** Guideline 5.1.1(v): any app supporting account
creation must let the user **initiate deletion from within the app** — not a support email,
not a web form.

**Approach.** `DELETE /v1/me`. Soft delete now, hard purge after 30 days, exactly as
[`../02-architecture/auth.md#8-account-deletion`](../02-architecture/auth.md#8-account-deletion)
specifies.

Immediately on request, all six steps: set `deletedAt`, `purgeAfter` and `ttl` on the
profile; `AdminDisableUser` then `AdminUserGlobalSignOut`; delete every `DEVICE#` row so
push stops; delete every EventBridge schedule with the user's prefix; revoke every invite
they created; and make the auth middleware `401` any token whose profile has `deletedAt`
set.

In the app: Settings → Account → Delete account, a confirmation screen stating plainly what
is deleted, what is retained and why, and that signing in within 30 days restores the
account. **Requires re-authentication immediately before the call** — a session left open on
an unlocked device must not be able to delete the account.

At purge, the retention rules matter and must be in the privacy policy: participant rows on
**other people's** activities are retained as guest-style records with the display name and
without the email or user link, and expenses the user was part of are retained with the
person reference. Deleting your account cannot delete someone else's plan or rewrite a
shared expense split so the arithmetic stops reconciling.

**Edge cases.** The purge runs from the daily maintenance sweep on `purgeAfter < now` **or**
from a TTL Streams handler. Streams are Phase 6, so in Phase 4 use a daily EventBridge rule
invoking a maintenance Lambda. S3 objects under `u/<userId>/` are batch-deleted and then
verified — an unverified batch delete leaves orphan objects paying storage indefinitely.

**Tests.** Integration: after `DELETE /v1/me`, the previous ID token `401`s, device rows are
gone, schedules are gone, and the Cognito user is disabled. Signing in within the window
routes to the restore screen and restores fully. A purge run against a profile with
`purgeAfter` in the past removes every item in the user's partitions, every activity they
own, and their `EMAIL#` row, and leaves participant rows on another user's activity in
place with the email removed.

---

### P4-21 / P4-22 — The force-upgrade kill switch

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

### P4-23 — App Store Connect app record

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

- **Privacy policy URL** — a real, reachable page (P4-20). Apple checks it.
- **Support URL** — a real page with a working contact route.
- **Copyright**, **Promotional text**, **Description**, **Keywords**.
- **App Review contact**: name, phone, email that a reviewer can actually reach.

---

### P4-24 — Privacy nutrition labels

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

### P4-25 — Screenshots at the required sizes

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

1. Today with all four sections populated (the worked example day is ideal).
2. The Add screen with the six type chips.
3. A plan detail with prep tasks and a list.
4. A list with a scheduled item showing its state line.
5. The watchlist with progress.

No device frames, no marketing overlay text, no claims. Plain screenshots are honest and
never get rejected for a mismatch between the marketing image and the app.

**Edge cases.** A screenshot showing a feature that does not exist in the submitted build is
a rejection under Guideline 2.3.3. Capture from the exact build being submitted.

---

### P4-26 — Review notes and the demo account

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
| 5.1.1(v) | Account creation with no in-app deletion path | P4-16/P4-18, and the review note naming the exact path |
| 4.8 | A third-party sign-in without an equivalent privacy-preserving option | Sign in with Apple shipped in Phase 1, tested on a physical device |
| 2.1 | Incomplete submission: a demo account that does not work, or an empty one | Pre-seeded, pre-confirmed, non-expiring demo account |
| 5.1.1(i) | Vague permission strings | Specific `NSCameraUsageDescription` / `NSPhotoLibraryUsageDescription` copy naming the feature |
| 5.1.2 | ATT prompt shown without tracking, or tracking without the prompt | No tracking, no ATT prompt, labels say so |
| 4.2 | "Minimum functionality" — an app that is a thin wrapper or a repackaged list | The app is a genuine multi-feature client; the screenshots and demo data must show it |
| 2.3.3 | Screenshots that do not match the app | Captured from the submitted build |
| 5.1.1 | Requiring an account for features that do not need one | The public invite page requires no account; that is Phase 5, so v1 legitimately requires an account for everything it offers |
| 1.5 | A support URL that 404s | P4-20 ships both pages before submission |
| 2.3.10 | Mentioning another platform in the description or screenshots | Do not reference Android or the web app in the App Store listing |

**Edge cases.** Expo apps are occasionally flagged under 4.7 (third-party software) when
OTA updates are used to change app behaviour. Expo Updates in v1 delivers only JavaScript
that matches the reviewed build's functionality; do not use it to gate or add features. Say
so in the review notes if OTA updates are enabled.

---

### P4-27 — TestFlight

**Approach.**

1. `eas build --platform ios --profile production` then `eas submit --platform ios`. The
   build appears in App Store Connect within ~15 minutes of the upload completing.
2. **Export compliance**: answered by `ITSAppUsesNonExemptEncryption: false` in the config
   (P4-04). Without it, every build blocks on a manual question.
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

### P4-28 — Performance pass

**Approach.** Measure, record the numbers in the PR, and only then decide what to change.
The targets are in [`../01-product/overview.md`](../01-product/overview.md) §7 and
[`../02-architecture/tech-stack.md#45-cold-start-budget`](../02-architecture/tech-stack.md#45-cold-start-budget).

| Target | Measurement | Gate |
| --- | --- | --- |
| S1: capture to saved under 5 s | Maestro flow, timed, median of 10 runs on a physical iPhone 13 or newer | Yes |
| S2: Today loads in one API call | Playwright network-count assertion | Yes |
| S3: Today renders under 1.0 s cached, 2.0 s cold | Instrumented client timing, mount to first painted row | Yes |
| Cold start init under 400 ms p95 | The CI cold-start job: force execution-environment recycling by updating an environment variable, invoke three times, read `initDuration` | Yes |
| Cold `GET /v1/agenda` under 700 ms total | Same job | Yes |
| Warm server-side p95 under 60 ms | CloudWatch `Duration` p95 over the smoke run | Report only |
| Lambda bundle under 5 MB zipped | `scripts/check-bundle-size.mjs` | Yes, already gating since Phase 0 |

Also resolve open question **OQ-3** here: run AWS Lambda Power Tuning against the real
agenda endpoint with realistic data and set the memory from the curve rather than leaving
1024 MB as an unmeasured guess. Record the curve in the PR.

**Edge cases.** Measure on a physical device, not the simulator — the simulator's JS
performance flatters the app by a wide margin. Measure over a real cellular connection for
S1 and S3, not office wifi.

---

### P4-29 — Accessibility pass

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
| Contrast ≥ 4.5:1 body / ≥ 3:1 controls, light and dark | Automated token-pair test (from P1-29) plus a manual check of any composed colour |
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

### P4-31 / P4-32 — Prod alarms and a rehearsed rollback

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

1. `https://ordinarydays.app` serves the production web build over CloudFront with a valid
   certificate, HSTS, and an **enforcing** CSP, and a full Playwright run produces zero CSP
   violations.
2. A direct `GET` against the prod web S3 bucket URL returns `403`.
3. A production EAS build installs from TestFlight on a physical device and its debug row
   shows `api.ordinarydays.app`, not the dev host.
4. Setting a reminder two minutes out, backgrounding the app, and waiting delivers a push
   whose title is the activity's title verbatim and whose tap opens that activity's screen.
5. A reminder on a daily 18:00 task fires at 18:00 local on both sides of a DST transition,
   verified by scheduling across the boundary with a shifted device clock.
6. A recurring series never has more than two pending EventBridge schedules, verified by
   listing schedules for a daily series after three fires.
7. Completing or skipping an occurrence before its reminder fires cancels that schedule.
8. A notification held by quiet hours arrives at 07:00 local; a reminder for a 06:30
   activity arrives at 06:30; four held items arrive as one `held_digest`.
9. A clean install reaches Today with **no** system notification dialog; the pre-prompt
   appears the first time a reminder is set; `Not now` does not re-appear for 14 days.
10. There is no numeric badge anywhere in the app — on the app icon, the tab bar, the
    Profile entry point, or any row.
11. `Settings → Account → Delete account` requires re-authentication, and after confirming:
    the previous token `401`s, no push arrives, and no schedule fires for that user.
12. Signing in within 30 days restores the account completely, including activities, lists
    and settings.
13. A purge run on a `purgeAfter`-elapsed profile deletes every item in that user's
    partitions and their S3 objects, and leaves their participant row on another user's
    activity present with the display name and without the email.
14. `GET /v1/me/export` (or the equivalent) returns a presigned link valid for 24 hours to a
    JSON file containing the user's activities, lists and settings.
15. Setting `/od/prod/client/min-version` above the shipped version makes the app show the
    blocking upgrade screen within five minutes, with no deploy; a request with no
    `X-Client-Version` header is not blocked.
16. App Store Connect shows the app record complete: bundle ID `app.ordinarydays.ios`,
    privacy policy and support URLs both returning 200, privacy labels matching the table in
    P4-24, screenshots at 1320 × 2868, and review notes naming the account-deletion path.
17. The demo account signs in on the production build with no email verification step and
    lands on a populated Today.
18. Beta App Review is passed and at least three external testers who are not the founder
    have installed the build and completed the create-a-task flow.
19. Measured and recorded: S1 median under 5 s on a physical device over cellular; S3 under
    1.0 s cached and 2.0 s cold; Lambda init p95 under 400 ms; cold `GET /v1/agenda` under
    700 ms; zipped bundle under 5 MB.
20. Accessibility: axe-core reports zero serious or critical violations on every web route;
    the VoiceOver walkthrough of Today, a list and a plan detail is recorded and matches
    §6.2's labels; layouts hold at AX5 and at 320 pt width.
21. A rollback of the prod API alias has been executed deliberately, timed, and recorded in
    the runbook, and CDK and reality were brought back into agreement afterwards.
22. Prod DynamoDB has PITR and deletion protection on, and an on-demand backup has been
    taken and its restore verified into a scratch table at least once.

## Out of scope for this phase

| Do not build | Owned by |
| --- | --- |
| Sharing, participants, invitations, the public invite page, guest RSVP | Phase 5 |
| SES production access — dev and prod both stay in the sandbox until there are guests to email | Phase 5 |
| Guest → account linking in the post-confirmation trigger | Phase 5 |
| iOS share-sheet ingestion | Phase 8 (P8-11) |
| Expenses, balances, settlement, the People layer | Phase 6 |
| DynamoDB Streams, the balance recalculation fan-out | Phase 6 |
| The 60-day GSI archival sweep (the deletion purge job is Phase 4; the archival sweep is not) | Phase 8 (P8-33) |
| Web push, service worker, VAPID | Not in v1 |
| Any AI capture implementation | Phase 7 |
| A public App Store release — this phase ends at TestFlight external testing | Phase 8 |
| An analytics or attribution SDK — adding one changes the privacy labels | Not in v1 |
| iPad-specific layout and iPad App Store assets | Post-beta |
| In-app purchases, subscriptions, paywalls | Phase 7 at the earliest (open question OQ-6) |
| AWS WAF | Only if the public surface is actually abused |

## Risks and gotchas

| Risk | Signal | Mitigation |
| --- | --- | --- |
| **Apple Developer enrolment is not complete** when the phase starts | P4-03 blocks and everything downstream of it stalls | Enrolment starts in Phase 1, not Phase 4. Organisation enrolment with a D-U-N-S number can take weeks. |
| **Rejection for missing in-app account deletion** | The first submission comes back | P4-16/P4-18 are built early in the phase, and the review notes name the exact path. This is the single most common rejection for an app with accounts. |
| **Rejection under 4.8** because Sign in with Apple is broken in the production build only | Apple sign-in works on dev and fails on prod | The prod bundle identifier must match the App ID registered for Sign in with Apple exactly (P4-04), and both Cognito hosted-UI domains must be on the Apple Services ID. Test Apple sign-in on the TestFlight build, not only on dev. |
| An enforcing CSP blocks the app's own bundle | A blank page on prod with no server error and therefore no alarm | Report-only for a week first; read the reports; then enforce. Playwright asserts zero violations. |
| A TestFlight build points at the dev API | Beta testers write to dev; their data is lost when dev is wiped | The debug row showing the API host, asserted in the pre-distribution checklist. |
| EAS free-plan queue delays the build | The submission slips by a day | Never make a deploy depend on a build; schedule the first production build for a day when waiting is fine. |
| Expo push receipts are never checked | Pushes silently stop for users who reinstalled, and the token eventually throttles | The reminder Lambda reads receipts and deletes `DeviceNotRegistered` device rows. |
| Reminder scheduling and agenda expansion disagree at a DST boundary | A reminder fires an hour early twice a year | Both derive from `toUtcInstant` in `packages/shared/src/recurrence/calendar.ts`; a test asserts agreement at the boundary. |
| Unbounded EventBridge schedules for long-running series | The account schedule quota is approached and creates start failing | Only the next two occurrences are ever scheduled; acceptance criterion 6 asserts it. |
| Privacy labels under-declare | Rejection, and a second review cycle | The P4-24 table is derived from a grep of the actual dependency list, not from memory. |
| Screenshots show a feature not in the build | Rejection under 2.3.3 | Captured from the submitted build with seeded data. |
| The rollback path has never been executed | It does not work when it is needed | P4-32 rehearses it deliberately on prod and records the time. |
| The kill switch is used for feature gating | Users learn to expect forced updates and the mechanism stops meaning anything | Documented as broken-builds-only in the runbook. |
</content>
