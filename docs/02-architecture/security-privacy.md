# Security and privacy

**Status:** canonical for the threat model, IAM policy, data handling, and privacy
compliance. Identity mechanics are in `auth.md`; authorisation rules are in
`api-contract.md` §3. This document covers everything else.

The security posture this app needs: it is a consumer planning app holding a small amount
of personal data about a small number of people, run by one person. It does not need a
SOC 2 programme. It does need to not leak one user's plans to another, not lose the
founder's AWS account, and not be embarrassing when someone reads the code.

---

## 1. Threat model

| # | Asset | Threat | Mitigation |
| --- | --- | --- | --- |
| 1 | Any user's activity, list, or expense | **IDOR** — an authenticated user requests `GET /v1/activities/act_01J…` for an ID belonging to someone else, or guesses a neighbouring ULID | The tenant key comes **only** from the verified token's `custom:app_user_id` claim, never from the path, query, or body (`auth.md` §5.3). Every activity-scoped service method calls `assertActivityAccess(userId, activityId, level)` first, which loads `ACT#<id>/META` and checks `ownerId`, then `ACT#<id>/PART#<personId>`. A caller with no relationship gets **`404`, never `403`** (`api-contract.md` §3) so existence is not confirmed. Enforced in one helper, not per handler, and covered by a test that walks every route and asserts the check is reached. |
| 2 | Activity IDs | **ULID enumeration** — ULIDs are time-sortable, so knowing one reveals roughly when neighbours were created | ULIDs are not a security boundary and are not treated as one. Access control (row 1) does not depend on the ID being unguessable. IDs are opaque to the client and DynamoDB `pk`/`sk` are never exposed (`data-model.md` §8). |
| 3 | A shared plan's private details | **Invite token guessing or enumeration** on the public surface | Tokens are 22 chars of base62 from `crypto.randomBytes(16)` — **128 bits of entropy**, not ULIDs, precisely so creation order does not leak (`data-model.md` §4.9). Lookup is a direct `GetItem`; a wrong token costs one failed read and returns `404` with no distinguishing timing. Public routes are rate-limited to 30 req/min per IP, and RSVP to 10 attempts/hour per token. Tokens expire 90 days after the plan date. At 30 req/min, brute-forcing 128 bits is not a threat that requires further mitigation. |
| 4 | Every user's data | **Tenant isolation failure in a single DynamoDB table** — one bad `Query` returns another user's items | Key construction happens **only** in the repository layer; no `pk`/`sk` string is built anywhere else. Every user-scoped query is `pk = USER#<userId>` or `gsi1pk = U#<userId>#…` with the `userId` from the token. **`Scan` is banned in application code** — a `Scan` in a PR is an automatic rejection (`data-model.md` §5), and a lint rule plus a CI grep enforce it. `ACT#` partition reads are gated by the access check in row 1 before the query runs. Repository tests run against DynamoDB Local with two seeded users and assert that user A's queries never return user B's items. |
| 5 | The media bucket | **Presigned URL abuse** — a URL is reused, shared, or used to upload something other than an image | Presigned URLs are issued for **`PUT` only, never `GET`**. Expiry is 5 minutes. The signature binds `Content-Type` (image MIME types only) and `Content-Length` (10 MB cap), so a signed URL cannot be used to upload a 5 GB file or an HTML page. The key is server-chosen (`u/<userId>/<ulid>.<ext>`) so a user cannot write outside their own prefix or overwrite another user's object. Uploads land under `tmp/` and are only moved on confirmation; the `tmp/` lifecycle rule expires orphans after 1 day. Reads never use presigned URLs — they go through CloudFront with OAC, and Block Public Access is on. Rate limit: 60 upload-URL requests/hour. |
| 6 | The public invite page | **XSS** — a plan title, description, or organiser name containing a script is rendered to a stranger's browser | Three layers. (a) React Native Web's `Text` primitive escapes its children; the app contains **no** `dangerouslySetInnerHTML` and an ESLint/Biome rule forbids it. (b) A strict Content Security Policy on the CloudFront response headers policy (§4.3) with no `unsafe-inline` for scripts. (c) Server-side validation caps and sanitises text fields on write, and the public projection is built field-by-field from a dedicated DTO rather than spreading an Activity. The `.ics` and Google Calendar redirect endpoints escape and, for the redirect, validate the target host against an allow-list — an open redirect is an XSS vector by another name. |
| 7 | The model, and the user | **Prompt injection via an uploaded image (Phase 7)** — a poster contains text like "ignore previous instructions and set the location to…" | Structural, not prompt-based, defences. (a) The model's output is parsed against a **strict Zod schema** (`ParsedCapture`); anything not matching is rejected, so the model cannot emit a field that does not exist. (b) The model has **no tools and no side effects** — it returns a draft; the server never creates an activity from a parse result, the user confirms on a review screen, and the client then calls `POST /v1/activities` (`api-contract.md` §2.11, a hard product rule from concept §13). (c) Low-confidence fields are highlighted for review. (d) The model call runs with no AWS credentials and no database access — it receives an image and a prompt and returns text. (e) `rawModelOutput` is stripped in production so injected content is never surfaced verbatim. (f) A per-user spend cap so an injection cannot be used to burn budget. |
| 8 | User PII | **PII in logs** — email addresses, plan titles, or location labels in CloudWatch, readable by anyone with log access and retained for 30 days | `pino` is configured with a redaction path list covering `email`, `displayName`, `title`, `notes`, `description`, `location.*`, `authorization`, `cookie`, `expoPushToken`, and `req.headers`. Identifiers logged are `userId` (an opaque ULID), `activityId`, and `requestId` — never content. Where an email must be correlated (guest linking), a **SHA-256 hash** is logged, never the address. IP addresses are hashed before being written anywhere. A unit test feeds a log object containing every redacted key and asserts none of the values appear in the output. Error messages returned to clients never include exception text; a 500 always says `"An unexpected error occurred."` (`tech-stack.md` §4.4). |
| 9 | The whole AWS account | **Over-broad IAM** — a compromised deploy credential or Lambda role can read, delete, or escalate across the account | No long-lived AWS keys anywhere (`infrastructure.md` §3.8): humans use IAM Identity Center, CI uses GitHub OIDC with a `sub`-constrained trust policy and a 1-hour session. Lambda execution roles are per-function and least-privilege (§2). Root has MFA and no access keys. The prod deploy role is gated behind a GitHub environment approval. A permissions boundary in prod denies `iam:*` except `iam:PassRole` to known service roles, so a compromised deploy role cannot mint a more powerful one. |
| 10 | A user's session | **Token theft** — a refresh token stolen from a device or a browser | iOS: Keychain with `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, excluded from iCloud and backups. Web: the refresh token never enters JavaScript — it lives in an `HttpOnly; Secure; SameSite=Lax` cookie, with double-submit CSRF protection (`auth.md` §4.2). **Refresh token rotation is enabled**, so a stolen token is single-use and its reuse invalidates the session. ID token lifetime is 60 minutes. `GlobalSignOut` on sign-out and on account deletion invalidates everything immediately. |
| 11 | The API | **Denial of wallet** — an attacker cannot take the service down cheaply, but can make it expensive | Reserved concurrency, API Gateway throttling, per-user and per-IP rate limits, and the alarms in `cost-model.md` §5. The public surface is the exposed one and is the most tightly limited. |
| 12 | Money | **Expense manipulation** — a participant edits a split so the arithmetic no longer reconciles, or edits someone else's expense | Splits are validated server-side to sum **exactly** to `amountCents` (`api-contract.md` §2.9); integers only, never floats. A participant may add expenses but may only edit or delete ones they created; the owner may edit any on their activity. `Balance` is a cache and is always recomputable from the underlying `Expense` and `Settlement` rows — the API must be able to list them (`data-model.md` §4.8), so no balance is ever unexplained. |
| 13 | Another user's contact list | **Contact enumeration** — probing `/v1/people` or the participant picker to discover who else uses the app | `Person` records live under their owner's partition (`USER#<owner>/PERSON#`) and are only ever queried with the token's own `userId`. There is no global user directory and no "search users by email" endpoint. Adding a participant by email creates a **guest** record in the adder's own partition; the API response does not reveal whether that address has an account. Guest→account linking happens later, server-side, in the post-confirmation trigger. |
| 14 | The supply chain | **A malicious or compromised npm package** | Lockfile committed, `--frozen-lockfile` in CI, `save-exact=true`. `pnpm audit --audit-level=high` nightly and on PRs. Dependabot with grouped PRs. `pnpm` does not run install scripts for new dependencies by default in recent versions — keep that default and approve build scripts explicitly. The Lambda bundle is built from the lockfile, not from a floating range. §7. |

---

## 2. IAM

### 2.1 Principles

1. **No long-lived credentials.** Not for humans, not for CI, not for the root account.
   Everything is a short-lived assumed-role session.
2. **One role per function.** The API Lambda, the reminder Lambda, and each Cognito
   trigger have separate execution roles. A shared role means the reminder function can do
   everything the API can.
3. **Resource-scoped, not wildcard.** Policies name the exact table ARN, the exact index
   ARN, and the exact bucket prefix. `Resource: "*"` is permitted only for actions that
   genuinely have no resource (there are almost none we use).
4. **Deny by default, grant by use.** A permission is added when a code path needs it and
   is removed with that code path. CDK's `grantReadWriteData` helpers are preferred over
   hand-written policies because they scope correctly and update when the resource changes.
5. **No `iam:*` in application roles.** A Lambda has no business creating roles or
   attaching policies.
6. **Separate the deploy path from the runtime path.** The GitHub deploy role can create
   infrastructure but cannot read the DynamoDB table's data. The Lambda role can read the
   data but cannot change infrastructure.
7. **Scope by stage.** `od-github-deploy-dev` cannot touch `od-*-prod` stacks
   (`infrastructure.md` §3.8).

### 2.2 The API Lambda's execution policy

Least-privilege sketch. In CDK this is expressed through `grant*` calls plus a small number
of explicit statements; the resolved policy should look like this.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "TableAccess",
      "Effect": "Allow",
      "Action": [
        "dynamodb:GetItem",
        "dynamodb:BatchGetItem",
        "dynamodb:Query",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:DeleteItem",
        "dynamodb:TransactGetItems",
        "dynamodb:TransactWriteItems"
      ],
      "Resource": [
        "arn:aws:dynamodb:us-east-1:123456789012:table/od-main-prod",
        "arn:aws:dynamodb:us-east-1:123456789012:table/od-main-prod/index/GSI1"
      ]
    },
    {
      "Sid": "NoScanEver",
      "Effect": "Deny",
      "Action": ["dynamodb:Scan", "dynamodb:DeleteTable", "dynamodb:UpdateTable"],
      "Resource": "*"
    },
    {
      "Sid": "MediaUploadAndRead",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::od-media-prod-123456789012/u/*"
    },
    {
      "Sid": "NoBucketAdmin",
      "Effect": "Deny",
      "Action": ["s3:PutBucketPolicy", "s3:PutBucketAcl", "s3:DeleteBucket",
                 "s3:PutBucketPublicAccessBlock"],
      "Resource": "*"
    },
    {
      "Sid": "ReminderSchedules",
      "Effect": "Allow",
      "Action": ["scheduler:CreateSchedule", "scheduler:DeleteSchedule",
                 "scheduler:GetSchedule", "scheduler:UpdateSchedule"],
      "Resource": "arn:aws:scheduler:us-east-1:123456789012:schedule/od-reminders-prod/*"
    },
    {
      "Sid": "PassSchedulerRoleOnly",
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": "arn:aws:iam::123456789012:role/od-scheduler-invoke-role-prod",
      "Condition": { "StringEquals": { "iam:PassedToService": "scheduler.amazonaws.com" } }
    },
    {
      "Sid": "SendTransactionalEmail",
      "Effect": "Allow",
      "Action": ["ses:SendEmail"],
      "Resource": [
        "arn:aws:ses:us-east-1:123456789012:identity/ordinarydays.app",
        "arn:aws:ses:us-east-1:123456789012:configuration-set/od-prod"
      ],
      "Condition": {
        "StringEquals": { "ses:FromAddress": "no-reply@ordinarydays.app" }
      }
    },
    {
      "Sid": "ReadOwnSecrets",
      "Effect": "Allow",
      "Action": ["ssm:GetParameter", "ssm:GetParameters"],
      "Resource": "arn:aws:ssm:us-east-1:123456789012:parameter/od/prod/*"
    },
    {
      "Sid": "DecryptSsmParameters",
      "Effect": "Allow",
      "Action": "kms:Decrypt",
      "Resource": "arn:aws:kms:us-east-1:123456789012:alias/aws/ssm"
    },
    {
      "Sid": "SoftDeleteAndSignOutUsers",
      "Effect": "Allow",
      "Action": ["cognito-idp:AdminDisableUser", "cognito-idp:AdminUserGlobalSignOut",
                 "cognito-idp:AdminDeleteUser"],
      "Resource": "arn:aws:cognito-idp:us-east-1:123456789012:userpool/us-east-1_XXXXXXX"
    },
    {
      "Sid": "Logs",
      "Effect": "Allow",
      "Action": ["logs:CreateLogStream", "logs:PutLogEvents"],
      "Resource": "arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/od-api-prod:*"
    }
  ]
}
```

Notes on the choices that are not obvious:

- **The explicit `Deny` on `dynamodb:Scan`.** The ban on `Scan` is a code-review rule; this
  makes it a runtime impossibility. A `Scan` that slips through review fails with an
  authorisation error in dev, loudly, before it reaches prod. Migration scripts run under
  the admin identity, not this role, so they are unaffected.
- **`s3:PutObject` scoped to `u/*`.** The Lambda cannot write outside the user-content
  prefix, so it cannot, for example, overwrite the web bucket's `index.html` — which is a
  different bucket anyway, and is not in this policy at all.
- **`iam:PassRole` conditioned on `iam:PassedToService`.** Creating an EventBridge schedule
  requires passing a role. Without the condition, this is a privilege-escalation primitive:
  pass a more powerful role to some other service. With it, the role can only ever be
  handed to the scheduler.
- **`ses:FromAddress` condition.** Prevents the function being used to send mail from any
  other address on the verified domain, which is what a spam-relay abuse of a compromised
  function would try.
- **No `cognito-idp:AdminCreateUser`, `AdminSetUserPassword`, or `AdminInitiateAuth`.** The
  API never creates or authenticates users directly; that is the client's job against
  Cognito, and granting these would let a compromised function impersonate anyone.
- The reminder Lambda gets a far smaller policy: `dynamodb:GetItem` and `Query` on the
  table only, plus logs. It has no write access and no S3, SES, or Cognito access at all.

---

## 3. Data classification and retention

| Data | Class | Where it lives | Why we hold it | Retention |
| --- | --- | --- | --- | --- |
| Email address (account) | **PII** | Cognito, `USER#/PROFILE`, `EMAIL#<email>/USER` | Identity, sign-in, account recovery, guest linking | Life of account; deleted at purge (30 days after deletion request) |
| Display name | **PII** | Cognito `name`, `USER#/PROFILE` | Shown to people you share plans with | Life of account. **Retained on other people's activities after deletion** as a name on their plan (`auth.md` §8) |
| Password | **Credential** | Cognito only, hashed and salted | Sign-in | Never stored by us in any form. We never see it — SRP means it is not transmitted. |
| Apple identity (`sub`, relay email) | **PII** | Cognito | Federated sign-in | Life of account |
| Contacts entered by the user (name, email, phone) | **PII, third-party** | `USER#<owner>/PERSON#` | Adding people to plans, computing balances | Life of the owner's account, or until the owner deletes the contact |
| Activity titles, notes, descriptions | **Personal content** | `ACT#/META` | The product | Life of account |
| Location labels and addresses | **Personal content, sensitive** | `ACT#/META.location` | Showing where a plan is | Life of account |
| Precise coordinates (`lat`/`lng`) | **Sensitive** | `ACT#/META.location` | Map links | Only stored when the user attaches a place. **We never collect device location** — there is no location permission in the app. |
| Photos and screenshots | **Personal content, potentially sensitive** | S3 `u/<userId>/` | Attachments, image capture | Life of the activity; purged with the account |
| Expense amounts and splits | **Financial** | `ACT#/EXP#`, `USER#/BAL#`, `USER#/SETTLE#` | Who owes whom | Life of account. **Retained on other people's activities** so their arithmetic still reconciles |
| Expo push token | **Device identifier** | `USER#/DEVICE#` | Delivering notifications | Until sign-out, device removal, or account deletion |
| IANA timezone | Low sensitivity | `USER#/PROFILE` | Correct wall-clock scheduling | Life of account |
| IP address | **PII** | Rate-limit counters only, **SHA-256 hashed** | Abuse prevention on the public surface | Length of the rate-limit window (≤ 1 hour), then TTL-deleted |
| Request logs | Operational | CloudWatch Logs | Debugging | **14 days dev, 30 days prod**, then automatic deletion |
| Invite tokens | **Capability** | `INVITE#<token>` | Public plan access | 90 days after the plan date, then TTL + 30 days |
| Idempotency records | Operational | `IDEM#<userId>#<key>` | Duplicate suppression | 24 hours via TTL |

**Data we deliberately do not collect:** device location, contacts from the phone's address
book, phone numbers of the account holder, date of birth, gender, payment details, health
data, biometrics, advertising identifiers, or any analytics identifier that persists across
reinstalls. Every one of these would appear on an App Store privacy label and none serve a
v1 feature. Contacts are typed in by the user, never imported from the device — that avoids
both the permission prompt and the privacy label entry entirely.

**Backups.** DynamoDB PITR is on in prod, giving a 35-day recovery window. A restored table
can contain data for a user who has since requested deletion. If a restore is ever
performed, the deletion queue must be re-run against the restored table before it serves
traffic. Note this in the runbook next to the restore command; it is exactly the step that
gets forgotten.

---

## 4. Input validation and output encoding

### 4.1 Validation rules

1. **Every inbound request is validated against a Zod schema before a handler runs**, via
   `@hono/zod-validator`. Path params, query strings, and bodies. There is no "trusted"
   input.
2. **The schema is the one in `packages/shared/src/schemas/`** — the same object the client
   used to build the request (`tech-stack.md` §5.1). One definition, two consumers.
3. **Strip unknown keys.** Schemas use `.strict()` on request bodies so an unexpected field
   is a `400`, not a silently-ignored value. This is what stops mass-assignment: a client
   cannot smuggle `ownerId` or `status` into a `PATCH`.
4. **Server-derived fields are never accepted from the client.** `ownerId`, `status`,
   `createdAt`, `updatedAt`, `participantCount`, `expenseTotalCents`, and
   `schemaVersion` are omitted from every input schema. `status` is derived on write
   (`data-model.md` §4.1).
5. **Bounds on everything.** `title` 1–200, `notes` ≤ 4,000, participants ≤ 50, agenda
   window ≤ 62 days, page size ≤ 200, upload ≤ 10 MB, request body ≤ 256 KB. Limits live in
   `packages/shared/src/constants.ts` and are imported by both sides — two copies of `50`
   is a bug waiting to happen.
6. **Format validation, not just type.** `isoDate` (`YYYY-MM-DD`), `hhmm` (`HH:mm`),
   `ianaTimezone` (checked against `Intl.supportedValuesOf('timeZone')`), `cents`
   (non-negative integer), prefixed ULIDs (`/^act_[0-9A-HJKMNP-TV-Z]{26}$/`). A malformed
   ID is rejected before it ever becomes a DynamoDB key.
7. **Money is integer cents. Always.** No floats anywhere in the money path. Splits must
   sum exactly to `amountCents`, validated server-side.
8. **Cursors are opaque and validated.** A cursor is base64 of a `LastEvaluatedKey`. On
   decode it is parsed against a schema **and** checked to belong to the requesting user —
   otherwise a crafted cursor is a way to start a query in someone else's partition.
9. **URLs are validated and scheme-restricted.** `sourceUrl`, `mapUrl`, `ticketUrl`,
   `recipeUrl` must parse as `http:` or `https:`. `javascript:`, `data:`, and `file:` are
   rejected. The Google Calendar redirect endpoint validates the target host against an
   allow-list before issuing a `302`.
10. **`details.kind` must equal `activity.type`**, checked at the schema boundary
    (`data-model.md` §4.4).

### 4.2 Output encoding

- **The client renders through React Native Web's `Text`**, which escapes its children.
  There is no `dangerouslySetInnerHTML` in the codebase and a lint rule forbids it.
- **The API only ever emits JSON**, with `Content-Type: application/json; charset=utf-8`
  and `X-Content-Type-Options: nosniff`. It never emits HTML, so there is no server-side
  HTML-escaping surface to get wrong.
- **Two exceptions produce non-JSON**, and both need explicit handling:
  - The `.ics` endpoints emit `text/calendar`. iCalendar has its own escaping rules —
    commas, semicolons, backslashes, and newlines in `SUMMARY`, `DESCRIPTION`, and
    `LOCATION` must be escaped per RFC 5545, and lines folded at 75 octets. Use a tested
    builder, not string concatenation, and set
    `Content-Disposition: attachment; filename="plan.ics"`.
  - The Google Calendar endpoint emits a `302`. The target is constructed from a fixed
    base URL with properly encoded query parameters, never from user-supplied URL fragments.
- **Error messages are safe to display.** The `message` field of an error envelope is
  written for a user. It never contains an exception message, a stack trace, a SQL or
  DynamoDB fragment, or an internal identifier. 500s always return the same literal string.
- **The public invite projection is built field-by-field**, not by spreading an Activity
  object. A field added to Activity for an authed screen must not appear on the public page
  by accident.

### 4.3 Content Security Policy

Applied by the CloudFront response headers policy on the web distribution:

```
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' https://media.ordinarydays.app data: blob:;
connect-src 'self' https://api.ordinarydays.app https://cognito-idp.us-east-1.amazonaws.com;
font-src 'self';
frame-ancestors 'none';
base-uri 'self';
form-action 'self';
object-src 'none';
upgrade-insecure-requests
```

`style-src 'unsafe-inline'` is required because React Native Web injects styles at runtime.
That is an accepted, documented weakening: inline **style** injection is a far weaker
primitive than inline **script**, and `script-src 'self'` — which is the one that matters —
has no unsafe directives. Revisit if RNW gains nonce support.

Alongside it: `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`,
`X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`,
`Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()`.

CORS on the API allows only the known web origins with `credentials: true`. Never `*` —
which the browser rejects in combination with credentials anyway, but stating the rule
prevents someone "fixing" a CORS error by widening it.

---

## 5. Rate limiting and abuse prevention

Limits are in `api-contract.md` §4 and are not restated. What matters here is how they are
implemented and where the public surface differs.

**Implementation.** A DynamoDB item per (subject, window): `RATE#<hashedSubject>#<window>`
with a `ttl` at the end of the window. An atomic `UpdateItem` with `ADD #n :one` and a
condition `#n < :limit`; a `ConditionalCheckFailedException` becomes `429 rate_limited`
with `Retry-After`. One write request unit — the limiter costs less than the request it
prevents. Expired counters delete themselves via TTL at no cost.

**Subject.** Authenticated routes key on `userId` from the verified token. Public routes
key on `sha256(clientIp + salt)`, so raw IP addresses never enter the table or the logs.
The client IP comes from the last hop of `X-Forwarded-For` as set by API Gateway, not from
a client-supplied header.

**The public invite surface** gets additional, tighter controls, because it is the only
part a stranger can reach:

| Control | Value | Prevents |
| --- | --- | --- |
| Per-IP limit | 30 req/min | General scraping |
| Per-token RSVP limit | 10 attempts/hour | Spamming one plan's RSVP list |
| Token entropy | 128 bits | Enumeration (row 3 of §1) |
| Token expiry | 90 days after plan date | Indefinite exposure of an old plan |
| Revocation | `DELETE /v1/activities/:id/invites/:token` → `410` | Owner regaining control |
| Response minimisation | A dedicated DTO, no shared service | Field leakage |
| No enumeration signal | `404` for unknown tokens, `410` for expired/revoked | Distinguishing "never existed" from "expired" is fine; distinguishing "exists but not yours" is not — and there is no such case here |

**Layered defences below the application.** API Gateway stage throttling (100 burst,
50 rps) and Lambda reserved concurrency (`cost-model.md` §5) cap total load regardless of
what the application-level limiter does. A request rejected at API Gateway costs nothing.

**AWS WAF is not deployed in v1.** It is $5/month for a web ACL plus per-request charges,
which exceeds the entire rest of the infrastructure bill (`aws-services.md` §2). The
trigger for adding it is *observed abuse* on the public surface, not a hypothetical. When
that happens, a rate-based rule and the managed common rule set on the web distribution is
a one-afternoon change.

**Email abuse.** Invite emails are only sent to addresses the user typed into their own
contact list, capped by the participant limit (50/activity) and the general rate limit.
SES bounce and complaint rates are alarmed at 5%; a spike is the earliest signal that the
invite flow is being used to send unwanted mail. The SES suppression list is on at account
level.

---

## 6. Secrets management rules

The mechanics are in `infrastructure.md` §5. The rules:

1. **Nothing secret enters the repository.** `.gitignore` covers `.env*` (except
   `.env.example`), `*.p8`, `*.p12`, `*.mobileprovision`, `cdk.out/`. `gitleaks` runs on
   every PR and pre-commit, and fails the build on a hit.
2. **Nothing secret enters a Lambda environment variable in plaintext.** Environment
   variables hold identifiers only — table names, bucket names, pool IDs, client IDs.
   Anyone with `lambda:GetFunctionConfiguration` learns nothing useful.
3. **Secrets live in SSM Parameter Store `SecureString`**, except the Phase 7 Anthropic key
   which lives in Secrets Manager for its rotation tooling (`aws-services.md` §1.11).
4. **Read once per cold start, cached in module scope with a 5-minute TTL.** Never per
   request.
5. **CDK's `checkSecretUsage` context flag is on**, so `cdk synth` fails if a `SecretValue`
   would be resolved into a CloudFormation template at synth time.
6. **The client bundle contains no secret.** The Cognito app client ID and the API base URL
   are in it and are public by design. Public OAuth clients with PKCE have no client
   secret; that is the point of PKCE.
7. **CI has no AWS credentials.** GitHub OIDC issues a 1-hour session scoped by the trust
   policy's `sub` condition. The only stored GitHub secrets are `EXPO_TOKEN` and Apple
   submission credentials, both scoped to the mobile workflow's environment.
8. **If a secret is ever committed, rotate it — do not just delete the commit.** Git
   history is public the moment it is pushed. The incident steps are in §9.

---

## 7. Dependency security

| Control | Detail |
| --- | --- |
| Lockfile | `pnpm-lock.yaml` committed. CI installs with `--frozen-lockfile`, so a lockfile that does not match `package.json` fails the build rather than silently resolving something new. |
| Exact versions | `.npmrc` sets `save-exact=true`. No `^` or `~` ranges in `package.json`. |
| Install scripts | `pnpm`'s default of not running lifecycle scripts for new dependencies is kept. Packages that genuinely need a build step are approved explicitly in `pnpm.onlyBuiltDependencies`. This is the mitigation for the most common npm supply-chain attack. |
| Audit in CI | `pnpm audit --audit-level=high` in the nightly workflow and on every PR. A high or critical advisory fails the PR job. Moderate and low open an issue. |
| Dependabot | `.github/dependabot.yml` with weekly checks on `npm` (all workspaces), `github-actions`, and `docker`. Patch and minor updates are **grouped** into one PR per ecosystem so review is one action, not twenty; majors come individually with a changelog to read. |
| Expo-managed packages | Never bumped by Dependabot — they are ignored in the config. They move only via `npx expo install --fix` after an SDK upgrade (`tech-stack.md` §6), and `npx expo-doctor` in CI fails on a mismatch. |
| Provenance | Prefer packages publishing npm provenance attestations where a choice exists. Not yet enforceable across the tree. |
| New dependency review | Adding a dependency is a deliberate decision documented in the PR: what it does, why nothing already present does it, its weekly download count, its last publish date, and its transitive dependency count. The best supply-chain defence is a small tree. |
| Runtime patching | Lambda's `nodejs22.x` managed runtime is patched by AWS. We do not pin a container image, so there is nothing to rebuild for a runtime CVE. |
| Secret scanning | GitHub secret scanning and push protection enabled on the repository, in addition to `gitleaks`. |

---

## 8. Privacy compliance

### 8.1 App Store privacy nutrition labels

Declared in App Store Connect. Getting this wrong is both a review rejection and a
credibility problem, so the list below is exact and must be revisited whenever a new field
is collected.

**Data used to track you:** **None.** No advertising identifiers, no third-party analytics
SDKs, no data shared with data brokers.

**Data linked to you** (associated with the user's identity):

| Data type | Category | Purpose | Notes |
| --- | --- | --- | --- |
| Email address | Contact info | App functionality, account management | Sign-in identity |
| Name | Contact info | App functionality | Display name shown to people on shared plans |
| Other user contact info | Contact info | App functionality | Names, emails, and phone numbers the user **types in** for their contacts. Declared even though they belong to third parties. |
| User content — other | User content | App functionality | Activity titles, notes, descriptions, list items |
| Photos or videos | User content | App functionality | Attachments and images used for capture |
| Coarse location | Location | App functionality | **Only** location *labels and addresses the user types or picks*. No device location is ever read; there is no location permission in the app. Declared as coarse because a user-entered address is location data. |
| Purchases / financial info | Financial info | App functionality | Expense amounts and splits. This is money data even though we process no payments. |
| Device ID | Identifiers | App functionality | The Expo push token, used solely for notification delivery |
| Customer support | Contact info | App functionality | Only if a support email is offered in-app |

**Data not linked to you:**

| Data type | Category | Purpose |
| --- | --- | --- |
| Crash data | Diagnostics | App functionality — if crash reporting is enabled |
| Performance data | Diagnostics | App functionality |

**Explicitly not collected:** device location, contacts imported from the device address
book, browsing history, search history, health and fitness, sensitive info, advertising
data, audio data, gameplay content, and any identifier used for tracking.

If Phase 7 sends user photos or text to a third-party model API, that is a **data
disclosure** and must be stated in the privacy policy and reflected in the labels. Plan for
that before the Phase 7 submission, not during review.

### 8.2 Account deletion and data export

**Deletion** is required by App Store Guideline 5.1.1(v) and must be initiable *in the app*
— not via a support email or a web form. `DELETE /v1/me`, Settings → Account → Delete
account, with re-authentication immediately before the call. Soft-delete now, purge after
30 days. The full mechanics, including exactly what is retained on other people's
activities and why, are in `auth.md` §8.

**Export** is offered alongside deletion: a JSON dump of everything in the user's own
partitions, generated on request and delivered as a presigned download link valid for 24
hours. It reuses the same partition walk the purge needs, so it is nearly free to build,
and it removes the "I cannot leave" objection before anyone raises it.

### 8.3 Privacy policy outline

Plain language, second person, no legalese theatre. Hosted at
`https://ordinarydays.app/privacy` as a static route in the web build, and linked from the
App Store listing (required) and from Settings.

1. **What this app is** — a personal planner. One paragraph.
2. **What we collect, and why** — the table from §3, rewritten as prose a person can read.
   Each item paired with the feature that needs it.
3. **What we do not collect** — device location, your phone's contacts, advertising
   identifiers, anything about your browsing. Stated positively because it is unusual
   enough to be worth saying.
4. **Who can see your data** — you; the people you explicitly share a plan with, and only
   the fields shown on that plan; anyone you send an invite link to, limited to what the
   public invite page shows. Nobody else. No data broker, no advertiser.
5. **Third parties we use, and what they get** — AWS (hosting; all of it), Apple (Sign in
   with Apple, push delivery), Expo (push token relay). From Phase 7: the model provider,
   and exactly what is sent to it. Each with a one-line "what they receive".
6. **Where it is stored** — AWS `us-east-1`, United States. Named plainly for anyone in
   the EU or UK reading it.
7. **How long we keep it** — the retention table from §3.
8. **Your choices** — export, delete, correct, turn off notifications, control what each
   shared plan reveals.
9. **Children** — the app is not directed at children under 13 and we do not knowingly
   collect their data.
10. **Security** — encrypted in transit and at rest; access limited to the operator;
    honest about what that means for a one-person project.
11. **Changes** — how we notify you.
12. **Contact** — a real, monitored address.

Written before the first TestFlight build, not the week of App Store submission. The App
Store listing requires a live privacy policy URL at submission time.

### 8.4 Training

> **User content is not used to train any model.** Activities, notes, photos, contacts,
> and expenses are never used as training data, never sold, and never shared with a third
> party except as needed to run the service (§8.3 item 5).

For Phase 7 specifically: content sent to the model provider is sent for inference only.
The provider's API terms must be confirmed to exclude API inputs and outputs from training
before the feature ships, and the confirmation recorded in the ADR. If that is ever not
true of the chosen provider, the feature does not ship with that provider.

This statement goes in the privacy policy verbatim and in the App Store listing description.
It is the kind of promise that is cheap to keep and expensive to break.

---

## 9. Incident response

One person, no on-call rota. The goal is that each of these is a command that can be run
from a phone at 2 a.m., not a project.

### 9.1 Revoke a user's tokens

```bash
# One user — invalidates every access, ID, and refresh token immediately.
aws cognito-idp admin-user-global-sign-out \
  --user-pool-id us-east-1_XXXXXXX --username 'user@example.com'

# Also disable the account so they cannot sign back in.
aws cognito-idp admin-disable-user \
  --user-pool-id us-east-1_XXXXXXX --username 'user@example.com'
```

**Every user at once.** There is no single Cognito call for this. Rotating the app client
does it: create a new app client, deploy the client apps pointed at it, delete the old one.
That is a shipped release, so it is slow. The faster emergency stop is a **kill switch**:
an SSM parameter `/od/{stage}/auth/min-token-issued-at` that the auth middleware reads
(cached 5 minutes) and compares against the token's `iat`, rejecting anything older. Set it
to `now` and every existing token becomes invalid within five minutes, with no deploy. This
parameter and the middleware check should be built in Phase 3, before there are users —
retrofitting it during an incident is not possible.

### 9.2 Rotate a secret

```bash
# 1. Put the new value.
aws ssm put-parameter --name /od/prod/auth/apple/private-key \
  --type SecureString --value "$(cat NewAuthKey.p8)" --overwrite

# 2. Force new execution environments so the 5-minute cache is bypassed immediately.
aws lambda update-function-configuration \
  --function-name od-api-prod \
  --environment "Variables={STAGE=prod,ROTATION_NONCE=$(date +%s),...}"

# 3. Revoke the old credential at its source (Apple, Anthropic, Expo).
# 4. Confirm: check logs for auth errors; run the smoke test.
```

The order matters. Put the new value **before** revoking the old one, or there is a window
with no working credential. Step 3 is the one people forget — a rotated-but-not-revoked key
is still a live key.

If a secret was committed to git: rotate first, then clean history, then force-push, then
assume the old value is permanently public regardless.

### 9.3 Take the API offline

In increasing order of severity, all fast, all reversible.

```bash
# 1. Throttle to zero — every request gets 429 at API Gateway. Instant, keeps the
#    infrastructure intact, and no Lambda is invoked.
aws apigatewayv2 update-stage \
  --api-id <api-id> --stage-name '$default' \
  --default-route-settings 'ThrottlingRateLimit=0,ThrottlingBurstLimit=0'

# 2. Or: reserved concurrency to zero — every invocation is throttled at Lambda.
aws lambda put-function-concurrency \
  --function-name od-api-prod --reserved-concurrent-executions 0

# 3. Or: roll back to the previous known-good version (infrastructure.md §4.4).
aws lambda update-alias \
  --function-name od-api-prod --name live --function-version <n-1>
```

Option 1 is the preferred emergency stop: it is a single API call, it takes effect in
seconds, it costs nothing while off, and reversing it is the same call with the real
numbers. Option 2 has the same effect but burns a Lambda invocation record per request.
Option 3 is what to do when the problem is a specific bad deploy rather than an active
attack.

The web app and the public invite pages keep serving from CloudFront while the API is off,
which is correct — a static page saying the plan could not load is better than a dead
domain.

### 9.4 Suspected data exposure

1. Stop the bleeding (§9.3).
2. Preserve evidence: CloudWatch Logs are already retained; export the relevant window to
   S3 **before** the retention period expires. Enable CloudTrail data events on the table
   and bucket if they are not already on.
3. Determine scope from the logs: which `userId`s, which `activityId`s, over what window.
   This is why `requestId` and `userId` are on every log line.
4. Revoke (§9.1) and rotate (§9.2) anything that could have been exposed.
5. Fix, with a regression test that would have caught it.
6. Notify affected users directly and honestly, within 72 hours. A one-person project has
   no excuse for a slow disclosure — there is nobody to coordinate with.
7. Write it up in `docs/05-operations/incidents/` — what happened, why, what changed. Add
   the detection you wish you had had.
