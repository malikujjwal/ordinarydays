# Cost model

**Status:** canonical for the cost target and the guardrails that enforce it. The target
from the project brief is **effectively $0/month of AWS spend at personal and small-beta
scale**, with the Apple Developer Program and the domain as the only unavoidable costs.

Two rules for anyone editing this document:

1. **Do not invent numbers.** The verified free-tier figures come from the project brief
   (verified Aug 2026) and are marked as such. Any other figure is marked **[verify]**
   with a link, and must be re-checked against the pricing page before it is quoted to
   anyone or used in a decision.
2. **Show the arithmetic.** Every projection below states its assumptions. When the
   assumptions turn out wrong, the estimate can be recomputed instead of rewritten.

---

## 1. Usage assumptions

Three scales. These are the inputs to every table in §2; change them here and everything
downstream follows.

| | 1 user (founder) | 100 users | 1,000 users |
| --- | --- | --- | --- |
| Monthly active users | 1 | 100 | 1,000 |
| App opens / user / day | 6 | 4 | 4 |
| API requests / user / day | 30 | 30 | 30 |
| **API requests / month** | **900** | **90,000** | **900,000** |
| Activities created / user / month | 60 | 40 | 40 |
| DynamoDB reads / API request | 3 | 3 | 3 |
| DynamoDB writes / user / month | 200 | 150 | 150 |
| Stored items / user (steady state, 1 yr) | 2,500 | 2,000 | 2,000 |
| Average item size | 1 KB | 1 KB | 1 KB |
| **DynamoDB storage** | **2.5 MB** | **200 MB** | **2 GB** |
| Images uploaded / user / month | 10 | 6 | 6 |
| Average image size after client resize | 300 KB | 300 KB | 300 KB |
| **New S3 storage / month** | **3 MB** | **180 MB** | **1.8 GB** |
| **S3 storage after 12 months** | **36 MB** | **2.2 GB** | **22 GB** |
| CloudFront egress / month | ~0.2 GB | ~15 GB | ~150 GB |
| Plan-invite and list-invite emails / month | 5 | 400 | 5,000 |
| Reminders fired / month | 60 | 3,000 | 30,000 |
| Lambda avg warm duration | 80 ms | 80 ms | 80 ms |

The API-request figure is deliberately conservative. The agenda endpoint is cached
client-side for 60 s with an `ETag` (`api-contract.md` §2.2) and the persisted query cache
(`tech-stack.md` §3.4) means a cold app open costs one conditional request, not six. Real
usage will likely be lower. Estimating high is the safe direction for a cost model.

Note the shape of the result before reading the tables: at 1,000 users the app is
**still inside every always-free allowance**. The costs that appear are the ones with no
free tier at all (Route 53) and the ones whose 12-month clock has run out (API Gateway,
S3, SES).

---

## 2. Per-service cost

Free-tier figures marked *(brief)* are the verified values from the project brief. Prices
marked **[verify]** must be re-checked before use.

### 2.1 Amazon Cognito

| | |
| --- | --- |
| Always free | **10,000 MAU**, and this allowance explicitly does not expire *(brief)* |
| 12-month | n/a |
| Beyond | Per-MAU pricing above 10,000 **[verify]** <https://aws.amazon.com/cognito/pricing/> |

| Scale | Usage | Monthly cost |
| --- | --- | --- |
| 1 user | 1 MAU | **$0.00** |
| 100 users | 100 MAU | **$0.00** |
| 1,000 users | 1,000 MAU | **$0.00** |

Cognito does not cost anything until 10,000 monthly actives. Advanced security features
are off (`aws-services.md` §1.1) because they are billed per MAU on top of this.

### 2.2 API Gateway (HTTP API)

| | |
| --- | --- |
| Always free | None |
| 12-month | **1M HTTP API calls/month** *(brief)* |
| Beyond | **$1.00 per million requests** *(brief)* |

| Scale | Requests/month | Year 1 | Year 2+ |
| --- | --- | --- | --- |
| 1 user | 900 | $0.00 | **$0.00** (rounds to zero) |
| 100 users | 90,000 | $0.00 | **$0.09** |
| 1,000 users | 900,000 | $0.00 | **$0.90** |

This is the clearest illustration of the 12-month cliff: at 1,000 users the app crosses
from free to $0.90/month on the anniversary of the account. That is not a problem; it is
worth knowing it is coming.

### 2.3 AWS Lambda

| | |
| --- | --- |
| Always free | **1M requests + 400,000 GB-seconds per month** *(brief)* |
| 12-month | n/a |
| Beyond | Per-request + per-GB-second, with ARM64 cheaper than x86 **[verify]** <https://aws.amazon.com/lambda/pricing/> |

GB-seconds are computed as `requests × duration × memory-in-GB`. At 1024 MB and 80 ms
average, each API request costs `0.080 × 1.0 = 0.08` GB-seconds.

| Scale | Invocations/month | GB-seconds | Monthly cost |
| --- | --- | --- | --- |
| 1 user | 960 (900 API + 60 reminders) | 77 | **$0.00** |
| 100 users | 93,000 | 7,440 | **$0.00** |
| 1,000 users | 930,000 | 74,400 | **$0.00** |

At 1,000 users we use 93% of the free request allowance and 19% of the free compute
allowance. **The request count is the binding constraint, not compute.** The first thing
to do if invocations become the limit is reduce chatty client calls, not shrink the
function.

### 2.4 Amazon DynamoDB

| | |
| --- | --- |
| Always free | **25 GB of storage** *(brief)* |
| Important caveat | The always-free 25 RCU/WCU applies to **provisioned mode only** and does **not** cover our on-demand request charges *(brief)* |
| 12-month | n/a |
| Beyond | On-demand per-request pricing **[verify]** <https://aws.amazon.com/dynamodb/pricing/on-demand/> |

Request units, derived from §1 (one read request unit covers a 4 KB eventually-consistent
read of a 1 KB item; one write request unit covers a 1 KB write):

| Scale | Read units/month | Write units/month | Storage | Monthly cost |
| --- | --- | --- | --- | --- |
| 1 user | 2,700 | 200 | 2.5 MB | **< $0.01** |
| 100 users | 270,000 | 15,000 | 200 MB | **~$0.05** [verify] |
| 1,000 users | 2.7M | 150,000 | 2 GB | **~$0.45** [verify] |

Storage is free at every scale — 2 GB against a 25 GB allowance. The cost is entirely
request charges, and it is cents. This is the trade the brief already made: on-demand costs
a little rather than requiring capacity planning that would throttle real users.

`GSI1` uses an `INCLUDE` projection (`aws-services.md` §1.4) rather than `ALL`, which cuts
both the index storage and the read units on the hottest query in the product.

### 2.5 Amazon S3

| | |
| --- | --- |
| Always free | None |
| 12-month | **5 GB Standard, 20,000 GET, 2,000 PUT** *(brief)* |
| Beyond | **$0.023/GB-month Standard** *(brief)*; request charges **[verify]** <https://aws.amazon.com/s3/pricing/> |

Storage grows cumulatively — this is the only line item in the whole model that does.

| Scale | Storage after 12 mo | Storage after 24 mo | Cost at 12 mo | Cost at 24 mo |
| --- | --- | --- | --- | --- |
| 1 user | 36 MB | 72 MB | **$0.00** | **$0.00** |
| 100 users | 2.2 GB | 4.3 GB | **$0.00** (inside 5 GB) | **$0.10** |
| 1,000 users | 22 GB | 43 GB | **$0.39** (5 GB free) | **$0.99** |

Requests are negligible because reads go through CloudFront, which caches. A cached image
is zero S3 GETs.

Two guardrails hold this line down and both are in `aws-services.md` §1.5: the client
resizes to a maximum of 2048 px before upload, and Intelligent-Tiering after 90 days moves
cold posters to a cheaper class automatically.

### 2.6 Amazon CloudFront

| | |
| --- | --- |
| Always free | **1 TB egress + 10M requests per month** *(brief)* |
| 12-month | n/a |
| Beyond | Per-GB by region **[verify]** <https://aws.amazon.com/cloudfront/pricing/> |

| Scale | Egress/month | Requests/month | Monthly cost |
| --- | --- | --- | --- |
| 1 user | 0.2 GB | ~2,000 | **$0.00** |
| 100 users | 15 GB | ~200,000 | **$0.00** |
| 1,000 users | 150 GB | ~2M | **$0.00** |

1 TB/month is an enormous allowance for a static app plus user images. At 1,000 users we
use 15% of it. This is the most comfortable line in the model — and the reason S3 is never
read directly from the internet (see §5).

### 2.7 Amazon Route 53

| | |
| --- | --- |
| Always free | **None. Route 53 has no free tier.** |
| 12-month | None |
| Beyond | ~**$0.50/hosted zone/month** flat, plus per-query charges; **alias queries to CloudFront and API Gateway are not charged** **[verify]** <https://aws.amazon.com/route53/pricing/> |

| Scale | Monthly cost |
| --- | --- |
| 1 user | **~$0.50** |
| 100 users | **~$0.50** |
| 1,000 users | **~$0.50** |

Nearly all of our records are aliases to CloudFront and API Gateway, which are free to
query. So the hosted zone fee is the whole cost, and it is fixed regardless of scale.

**This is the first real AWS charge in the project's life, and it appears at one user.** It
arrives in **Phase 5**, when the domain is registered and `DnsStack` is deployed — not
earlier, because there is no hosted zone before then (§2.15). From that point the
$0-of-AWS-spend target is really approximately-$0.50. Worth stating plainly rather than
discovering it on the first bill.

### 2.8 AWS Certificate Manager

Free, always, for public certificates. $0.00 at every scale.

### 2.9 EventBridge Scheduler

| | |
| --- | --- |
| Free tier | **[verify]** — not in the brief's verified list. <https://aws.amazon.com/eventbridge/pricing/> |
| Beyond | Per-invocation, fractions of a cent per thousand |

| Scale | Schedules fired/month | Monthly cost |
| --- | --- | --- |
| 1 user | 60 | **< $0.01** |
| 100 users | 3,000 | **< $0.01** [verify] |
| 1,000 users | 30,000 | **~$0.04** [verify] |

`ActionAfterCompletion: DELETE` means fired schedules delete themselves, so we never
accumulate toward an account quota and never pay for stale schedules.

### 2.10 Amazon SES

| | |
| --- | --- |
| Always free | None (the historically "always free" 62,000/month applied only to mail sent from EC2, which we do not use) |
| 12-month | **3,000 message charges/month** *(brief)* |
| Beyond | ~**$0.10 per 1,000 emails** **[verify]** <https://aws.amazon.com/ses/pricing/> |

| Scale | Emails/month | Year 1 | Year 2+ |
| --- | --- | --- | --- |
| 1 user | 5 | $0.00 | **$0.00** |
| 100 users | 400 | $0.00 | **$0.04** |
| 1,000 users | 5,000 | $0.20 (2,000 over) | **$0.50** |

Dev stays in the SES sandbox indefinitely — the only recipient is the founder's own
verified address, so sandbox costs nothing and needs no review. Production access is
requested in Phase 6; budget several days for the review.

### 2.11 SSM Parameter Store and Secrets Manager

| | |
| --- | --- |
| Parameter Store standard tier | Free, always, up to 10,000 parameters **[verify]** |
| Secrets Manager | ~**$0.40 per secret per month** + API call charges **[verify]** <https://aws.amazon.com/secrets-manager/pricing/> |

| Scale | Monthly cost |
| --- | --- |
| Any, Phases 0–7 | **$0.00** (Parameter Store only) |
| Any, Phase 8+ | **~$0.40** (one Secrets Manager secret for the Anthropic key) |

The reasoning for the split is in `aws-services.md` §1.11.

### 2.12 CloudWatch (Logs, Metrics, Alarms) and SNS

| | |
| --- | --- |
| Always free | **10 custom metrics, 10 alarms, 5 GB log ingestion, 5 GB log storage per month** *(brief)*; **SNS 1M publishes** *(brief)* |
| Beyond | ~$0.50/GB ingested, ~$0.03/GB-month stored, ~$0.30/custom metric, ~$0.10/alarm **[verify]** <https://aws.amazon.com/cloudwatch/pricing/> |

One structured JSON log line is roughly 400 bytes. One API request produces roughly two
lines (request completion plus, sometimes, a warning).

| Scale | Log volume/month | Alarms | Monthly cost |
| --- | --- | --- | --- |
| 1 user | ~1 MB | 8 | **$0.00** |
| 100 users | ~75 MB | 8 | **$0.00** |
| 1,000 users | ~750 MB | 8 | **$0.00** |

Comfortably inside 5 GB even at 1,000 users. Two things keep it there: **no custom
metrics** before Phase 8 (the free allowance is only 10, and each extra is $0.30/month), and
**explicit retention** on every log group — 14 days in dev, 30 in prod. The CloudWatch
default is "never expire", and a forgotten log group is the most common way a hobby AWS
account accrues storage charges quietly for years.

> **Amended in P0-17: the alarm column is per environment, the allowance is per account.**
> CloudWatch bills per **alarm metric**, and an alarm on a math expression is charged for
> every metric the expression references, not once. `ObservabilityStack` as written is 7
> alarm metrics per stage — six alarms, of which `ddb-throttles` reads two metrics. So the
> table's `$0.00` holds for the dev-only environment Phase 4 deploys, and Phase 5's second
> stage takes the account to 14 alarm metrics: four beyond the free 10, about **$0.40/month**
> at ~$0.10 each. That is a Phase 5 line to carry, not a Phase 0 one — nothing in
> `ObservabilityStack` is deployed before Phase 4. Dashboards are separately free to three
> per account; this is one per stage, so two.

### 2.13 AWS Budgets

The first **two** budgets are free; beyond that ~$0.02 per budget per day **[verify]**
<https://aws.amazon.com/aws-cost-management/pricing/>. We run three (see §6), so expect
roughly $0.60/month. That is the correct trade — a budget alert that costs 60 cents and
catches a $200 mistake pays for itself once.

Cost Anomaly Detection is free.

### 2.14 Total

| Scale | Year 1 | Year 2+ |
| --- | --- | --- |
| 1 user (founder) | **~$1.10/month** | **~$1.10/month** |
| 100 users | **~$1.15/month** | **~$1.30/month** |
| 1,000 users | **~$1.60/month** | **~$3.00/month** |

Where it goes at 1,000 users in year 2: Route 53 $0.50, Budgets $0.60, API Gateway $0.90,
SES $0.50, DynamoDB $0.45, S3 $0.39, everything else $0.00.

Add $0.40/month from Phase 8 for the Secrets Manager secret, and the model API spend in
§3.4, which dwarfs all of the above.

### 2.15 When the spend actually starts

Every figure in §2.14 is a *steady-state* number for a deployed system. Development is
local-first, so it does not apply for most of the build.

| Phase | What exists in AWS | AWS spend |
| --- | --- | --- |
| 0 | The account, a $1 budget, a cost anomaly monitor, IAM Identity Center, the CDK bootstrap stack, the GitHub OIDC provider and one deploy role. Plus one throwaway `SmokeStack` (a single SSM parameter), deployed and destroyed inside P0-31. | **$0.00** |
| 1–3 | Unchanged. Nothing is deployed. The product runs against DynamoDB Local with `AUTH_MODE=local`. | **$0.00** |
| 4 | The permanent dev environment: `AccountStack`, `DataStack`, `AuthStack`, `ApiStack`, `ObservabilityStack`. No domain, no CloudFront, no `SchedulerStack`, no prod. | **$0.00** — free-tier; single-digit cents at most |
| 5 | Route 53 hosted zone, ACM certificates, prod stacks, SES, EventBridge Scheduler, CloudFront. | **~$0.50–$1.10/month** |

The same table, resource by resource, is in `03-implementation/roadmap.md` §3.1.

**AWS spend is $0 for Phases 0 through 3** because nothing is deployed. The bootstrap
residue that survives Phase 0 is priced at zero at rest: an empty S3 bucket, an unused ECR
repository, five IAM roles, an OIDC provider, budgets and Cost Anomaly Detection. The only
Phase 0 cost is the temporary $1 card authorisation on account signup, which is not a
charge. **The first real charge in the project's life is the Route 53 hosted zone in Phase
5** at $0.50/month — the domain registration (§3.2) is the first invoice, and it is a
registrar fee rather than an AWS service fee. Phase 4's deployed dev environment sits
entirely inside **always-free** allowances rather than the 12-month free tier: Cognito's
10,000 MAU, Lambda's 1M requests and 400,000 GB-seconds, DynamoDB on-demand's 25 GB and its
per-request rates at one user's volume, API Gateway's first year, CloudWatch's 5 GB of logs
and 10 custom metrics, and SSM Parameter Store's standard tier. One founder signing in and
exercising the app does not approach any of those, so a deployed dev environment with no
domain, no CloudFront distribution and no prod stacks bills nothing. That is what makes it
safe to leave dev running between Phases 4 and 5 rather than tearing it down each evening.

---

## 3. Unavoidable non-AWS costs

### 3.1 Apple Developer Program — $99/year

Non-negotiable for shipping to the App Store or to TestFlight. Also the prerequisite for
Sign in with Apple (`auth.md` §2.2) and for push notification credentials. Auto-renews;
letting it lapse pulls the app from the store and breaks Sign in with Apple.

**$8.25/month amortised.** This is the largest recurring cost in the entire project until
Phase 8.

### 3.2 Domain — approximately $12–15/year

`.app` registration through Route 53. A `.app` domain is on the HSTS preload list, so it
is HTTPS-only by construction. Enable auto-renew; a lapsed domain takes down the API, the
web app, every outstanding invite link, and SES's domain identity simultaneously.
**[verify]** current pricing with `aws route53domains list-prices --region us-east-1 --tld app`.

**~$1.10/month amortised.**

### 3.3 Expo EAS — $0, with a caveat

The **free EAS plan includes a limited monthly quota of builds that run in a low-priority
queue.** In practice that means builds are free but may wait — sometimes minutes, sometimes
considerably longer at busy times — and once the monthly quota is used, further builds
either wait for the next month or require a paid plan.

**The zero-cost fallback is local builds on a Mac:** `eas build --local` (or
`npx expo run:ios --configuration Release`) runs the same build on the founder's own
machine with no queue and no quota. It requires macOS with Xcode installed, and it is
slower per build than a warm EAS worker, but it is genuinely free and unlimited.

The practical policy:

| Build type | Where |
| --- | --- |
| Development client, iterating daily | Local (`expo run:ios`) — fastest loop, no quota |
| Internal preview for testing on a device | EAS free tier, quota permitting; local otherwise |
| TestFlight / App Store release | EAS, so the build is reproducible and archived off the founder's laptop |

EAS Update (over-the-air JS updates) also has a free tier and is worth using for
JavaScript-only fixes — it turns a two-day App Store review into a two-minute publish. Keep
native changes on the store-review path.

**Check the current EAS plan limits at <https://expo.dev/pricing> before planning a release
week around them** — the free-tier build quota is the number most likely to have changed.

### 3.4 Phase 8 model API spend

This is the one line item that can become the dominant cost, and it is the reason capture
is deferred to Phase 8 and rate-limited to 20 requests/hour per user
(`api-contract.md` §4).

**Per-parse token estimates** (system prompt + user input + structured output):

| Operation | Input tokens | Output tokens |
| --- | --- | --- |
| `POST /v1/capture/parse` (text → fields for the caller-selected target) | ~800 | ~300 |
| `POST /v1/capture/link` (URL → fields for the selected target; includes fetched page excerpt) | ~2,000 | ~300 |
| `POST /v1/capture/extract` (image → fields for the selected target) | ~2,500 (image tokens dominate) | ~400 |

**Cost = (input tokens × input rate) + (output tokens × output rate).** Worked at
illustrative rates of **$3.00 per million input tokens and $15.00 per million output
tokens** — **[verify] against <https://www.anthropic.com/pricing> before relying on this**:

| Operation | Cost per call |
| --- | --- |
| Text parse | **~$0.007** (0.7 cents) |
| Link parse | **~$0.011** |
| Image extract | **~$0.014** (1.4 cents) |

Projected monthly spend at 10 text parses and 3 image extracts per active user per month:

| Scale | Parses/month | Monthly cost |
| --- | --- | --- |
| 1 user | 13 | **~$0.13** |
| 100 users | 1,300 | **~$13** |
| 1,000 users | 13,000 | **~$110** |

At 1,000 users the model spend is roughly **35× the entire AWS bill**. Three consequences
that must be built in from the start, not retrofitted:

1. The 20/hour per-user rate limit on `/v1/capture/*` is a **cost control**, not just an
   abuse control. It caps a single user's worst case at roughly $10/month.
2. A per-account monthly spend cap, enforced in the Lambda against a DynamoDB counter,
   which returns `429 rate_limited` when exceeded. Set it conservatively and raise it
   deliberately.
3. Capture is the first candidate for a paid tier. A free tier of, say, 20 parses per month
   with paid capture above it makes the economics work; unlimited free capture does not.

Use the cheapest model that reliably produces the structured output, and cache
aggressively: a re-parse of identical input text should return the stored result rather
than a new call.

---

## 4. What would actually generate a surprise bill

Every item here is a real, documented way a small AWS account has produced a four-figure
bill. Each has a specific guardrail.

| Risk | How it happens | Plausible damage | Guardrail |
| --- | --- | --- | --- |
| **NAT gateway** | Someone puts a Lambda in a VPC (to reach RDS, or "for security"), and a NAT gateway is required for it to reach any AWS API. It bills per hour **and** per GB, forever, whether or not traffic flows. | **~$32/month minimum**, more with data. The single most common serverless surprise bill. | **No Lambda is in a VPC. No VPC is created at all.** There is no VPC construct anywhere in `infra/`. A CDK assertion test fails the build if `AWS::EC2::NatGateway` or `AWS::EC2::VPC` appears in any synthesised template. |
| **CloudFront beyond the free tier** | A viral link, a hotlinked image, or a scraper pulling every asset repeatedly. 1 TB is generous but not infinite. | Per-GB egress above 1 TB; a sustained scrape could add tens of dollars. | Price class `PRICE_CLASS_100` (cheaper regions only). Long cache TTLs so origin fetches are rare. A CloudWatch alarm on `BytesDownloaded` > 100 GB/day. If it ever fires in earnest, add AWS WAF's rate-based rule — until then WAF's $5/month exceeds the risk. |
| **DynamoDB on-demand under a hot loop** | A client bug retries a failing request without backoff; a `useEffect` with a bad dependency array fires a query on every render; a recursive Lambda writes an item that triggers a stream that writes an item. | On-demand has **no ceiling**. A tight loop can bill hundreds of dollars in hours. | Lambda **reserved concurrency** (20 dev / 50 prod) caps total throughput at source. Per-user rate limiting at 120 req/min. API Gateway throttle at 50 rps. TanStack Query's `retry: 3` with exponential backoff and a retryability predicate. A CloudWatch alarm on `ConsumedWriteCapacityUnits`. **Streams handlers must never write to the same table without a guard attribute** — this is checked in review. |
| **Lambda in an infinite retry loop** | An async invocation (EventBridge, Streams) fails, Lambda retries twice, the failure is deterministic, and the event goes back on the queue. Or: a function invokes itself. | Free tier absorbs 1M invocations, so the first visible symptom is usually the DynamoDB bill, not the Lambda bill. | Reserved concurrency on every function. `maxEventAge` and `retryAttempts: 2` set explicitly on async invocations. A **dead-letter queue** on the reminder and stream handlers so a poison event leaves the retry cycle. A CloudWatch alarm on `Invocations > 10,000 in 1 hour` — nothing legitimate at our scale produces that. |
| **S3 storage growth from image uploads** | Users upload photos; nothing ever deletes them. Orphaned uploads (presigned PUT succeeded, the confirm call never happened) accumulate invisibly. Storage is cumulative and never goes down on its own. | Slow and quiet: $0.023/GB-month compounds. 500 GB is $11.50/month for data nobody reads. | 10 MB per-upload cap, enforced in the presigned URL's `Content-Length` condition. Client-side resize to 2048 px before upload. **Lifecycle rule expiring the `tmp/` prefix after 1 day** so orphaned uploads self-clean. Intelligent-Tiering after 90 days. Account deletion purges `u/<userId>/`. A monthly `S3 BucketSizeBytes` check in the nightly workflow. |
| **Data transfer out of S3 bypassing CloudFront** | A presigned GET URL, or a direct `s3.amazonaws.com` URL in a client, sends bytes straight out of S3 at standard egress rates instead of through CloudFront's 1 TB free allowance. | S3 egress is charged per GB from the first byte; CloudFront's first TB is free. Serving 100 GB directly instead of through CloudFront turns $0 into a real charge. | **Block Public Access on all four settings**, on every bucket. Bucket policy grants `s3:GetObject` **only** to `cloudfront.amazonaws.com` conditioned on the distribution ARN — a presigned GET from anywhere else is denied by the bucket policy. *(P3-23, 2026-08-26: on `od-media-{env}` the condition is `aws:SourceAccount` plus a wildcard distribution ARN, for the cycle reason in `infrastructure.md` §1.1. The control this row relies on is the `cloudfront.amazonaws.com` principal, which is unchanged, so the mitigation holds.)* Reads are only ever issued as `media.ordinarydays.app` URLs. Presigned URLs are issued for `PUT` only, never `GET`. |
| **Forgotten dev resources** | A dev stack left running, a test table with data, an orphaned CloudFront distribution from an abandoned experiment. | Small individually; the problem is that nobody looks. | Everything is in CDK, so `cdk destroy 'od-*-dev'` removes the whole environment cleanly. Cost allocation tags (`Stage`, `Component`) make an orphan visible in Cost Explorer. The nightly workflow posts the month-to-date cost to a GitHub issue if it exceeds $1. |
| **Log retention set to "never expire"** | The CloudWatch default. A log group created outside the `NodeLambda` construct inherits it. | $0.03/GB-month forever, on data nobody will read after a week. | Retention is set explicitly in the shared `NodeLambda` construct (`infrastructure.md` §1.3), so it cannot be forgotten for a Lambda. A CDK assertion test fails the build if any `AWS::Logs::LogGroup` in a synthesised template lacks a `RetentionInDays`. |
| **Model API abuse (Phase 8)** | A script hammers `/v1/capture/parse`. Each call costs real money at the model provider, and AWS guardrails do not see it at all. | Unbounded, and **invisible to AWS Budgets** — it is a third-party bill. | 20 req/hour per user. A per-account monthly spend counter in DynamoDB that hard-stops at a configured ceiling. Spend alerts configured in the Anthropic console, independently of AWS. Capture requires authentication — it is never on the public surface. |

---

## 5. Concrete guardrails

Each with the CDK-level setting that implements it. If a guardrail has no code, it is not a
guardrail.

### 5.1 AWS Budgets

```ts
// infra/lib/stacks/account-stack.ts
const subscribers = [{ subscriptionType: 'EMAIL', address: cfg.alertEmail }];

const budget = (name: string, amount: number, thresholds: number[]) =>
  new budgets.CfnBudget(this, name, {
    budget: {
      budgetName: name,
      budgetType: 'COST',
      timeUnit: 'MONTHLY',
      budgetLimit: { amount, unit: 'USD' },
    },
    notificationsWithSubscribers: [
      ...thresholds.map((t) => ({
        notification: {
          notificationType: 'ACTUAL',
          comparisonOperator: 'GREATER_THAN',
          threshold: t,
          thresholdType: 'PERCENTAGE',
        },
        subscribers,
      })),
      {
        notification: {
          notificationType: 'FORECASTED',
          comparisonOperator: 'GREATER_THAN',
          threshold: 100,
          thresholdType: 'PERCENTAGE',
        },
        subscribers,
      },
    ],
  });

budget('od-budget-warn', 5, [100]);            // $5:  alert at 100% actual + forecast
budget('od-budget-alarm', 20, [50, 80, 100]);  // $20: alert at 50/80/100% actual + forecast
budget('od-budget-zero', 1, [100]);            // any spend at all is worth knowing about
```

Plus Cost Anomaly Detection on the whole account (`CfnAnomalyMonitor` +
`CfnAnomalySubscription`, `$5` threshold), which catches a *change* in a service that is
still under budget.

Budgets notify. They do not stop anything. Everything below is what actually stops spend.

### 5.2 Lambda reserved concurrency

```ts
new NodeLambda(this, 'Api', {
  name: 'api',
  memorySize: 1024,
  timeoutSeconds: 15,
  reservedConcurrency: cfg.stage === 'prod' ? 50 : 20,   // <- the hard ceiling
});
```

At 50 concurrent executions × 15 s timeout, the absolute worst-case throughput is bounded.
This is the single most effective cost guardrail in the system because it caps the rate at
which every downstream service can be called. It also caps availability, which is the
trade: a genuine traffic spike gets `429`s rather than a bill. At this stage that is the
right trade, and the `api-throttles` alarm tells us when to raise it.

### 5.3 API Gateway throttling

```ts
new apigwv2.HttpApi(this, 'HttpApi', {
  defaultDomainMapping: { domainName, mappingKey: undefined },
});
// Stage-level throttle:
const stage = api.defaultStage!.node.defaultChild as apigwv2.CfnStage;
stage.defaultRouteSettings = { throttlingBurstLimit: 100, throttlingRateLimit: 50 };
```

A request rejected at API Gateway never invokes Lambda and never touches DynamoDB, so this
is the cheapest possible place to shed load.

### 5.4 Per-user rate limits

Enforced in the Lambda with a DynamoDB counter item and a TTL (`api-contract.md` §4):

| Scope | Limit |
| --- | --- |
| Authenticated, general | 120 req/min |
| `POST /v1/capture/*` | 20 req/hour |
| `POST /v1/attachments/upload-url` | 60/hour |
| `/public/v1/*` | 30 req/min per IP |

The counter item is `RATE#<hashedSubject>#<window>` with `ttl` set to the end of the
window, so expired counters delete themselves at no cost. An `UpdateItem` with
`ADD #n :one` and a condition on the limit is one write request unit — the rate limiter
costs less than the request it prevents.

### 5.5 S3 lifecycle rules

```ts
new s3.Bucket(this, 'Media', {
  blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
  encryption: s3.BucketEncryption.S3_MANAGED,
  enforceSSL: true,
  lifecycleRules: [
    { abortIncompleteMultipartUploadAfter: Duration.days(1) },
    { prefix: 'tmp/', expiration: Duration.days(1) },
    {
      transitions: [{
        storageClass: s3.StorageClass.INTELLIGENT_TIERING,
        transitionAfter: Duration.days(90),
      }],
    },
  ],
});
```

### 5.6 Log retention

```ts
// In the shared NodeLambda construct — never set per-function.
logRetention: cfg.stage === 'prod'
  ? logs.RetentionDays.ONE_MONTH
  : logs.RetentionDays.TWO_WEEKS,
```

Asserted in `infra/test/`:

```ts
test('every log group has a retention policy', () => {
  const t = Template.fromStack(stack);
  for (const lg of Object.values(t.findResources('AWS::Logs::LogGroup'))) {
    expect(lg.Properties?.RetentionInDays).toBeDefined();
  }
});

test('no VPC or NAT gateway is ever created', () => {
  const t = Template.fromStack(stack);
  expect(Object.keys(t.findResources('AWS::EC2::VPC'))).toHaveLength(0);
  expect(Object.keys(t.findResources('AWS::EC2::NatGateway'))).toHaveLength(0);
});
```

### 5.7 DynamoDB TTL

```ts
new dynamodb.Table(this, 'Main', {
  tableName: `od-main-${cfg.stage}`,
  partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
  sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  timeToLiveAttribute: 'ttl',                       // <- free deletion
  pointInTimeRecoverySpecification: {
    pointInTimeRecoveryEnabled: cfg.pointInTimeRecovery,
  },
  deletionProtection: cfg.stage === 'prod',
  removalPolicy: cfg.removalPolicy,
});
```

TTL deletion consumes **no write capacity** — it is free. Everything ephemeral uses it:
idempotency records (24 h), rate-limit counters (window length), invite tokens (expiry +
30 days), soft-deleted profiles (30 days). Deleting these with an explicit `DeleteItem`
would cost a write unit each.

### 5.8 CloudWatch alarms with a cost purpose

Beyond the correctness alarms in `aws-services.md` §1.12, three exist specifically for
cost:

| Alarm | Threshold | Catches |
| --- | --- | --- |
| `api-invocations-spike` | Lambda `Invocations` > 10,000 in 1 hour | A retry loop or a scraper, before it becomes a bill |
| `ddb-write-spike` | `ConsumedWriteCapacityUnits` > 50,000 in 1 hour | A hot write loop |
| `cf-egress-spike` | CloudFront `BytesDownloaded` > 100 GB in 1 day | Hotlinking or a scrape |

All three publish to the `od-alerts-{env}` SNS topic → email. SNS's always-free 1M
publishes covers this many times over.

> **Raised in P0-17, not resolved: only `api-invocations-spike` is owned by a task.** It is
> in `aws-services.md` §1.12's alarm table and is built by P0-17. `ddb-write-spike` and
> `cf-egress-spike` appear **only here** — they are in no alarm table, no phase task builds
> them, and `ObservabilityStack` is not given the CloudFront distributions a
> `cf-egress-spike` would need. P0-17 built the six alarms its phase task names and did not
> invent two more, because each would cost an alarm metric against an allowance §2.12 shows
> is already tight at two stages. The founder decides which way this closes: add both to
> `aws-services.md` §1.12 with a phase task that owns them (Phase 4 for the table, Phase 5
> for CloudFront, since that is when the resources exist), or delete them from this section.

---

## 6. When this stops being free

**AWS spend stays under $5/month until roughly 10,000 monthly active users.** The binding
constraints, in the order they are reached:

| Milestone | What happens |
| --- | --- |
| **1 user, month 1** | Route 53's $0.50/month hosted zone. The bill is never truly $0. |
| **~1,100 users** | API Gateway crosses 1M requests/month (after the 12-month free tier has expired), at $1.00/M. Cost: ~$1/month. |
| **~1,100 users** | Lambda crosses 1M invocations/month. Cost: cents. |
| **~2,500 users** | S3 storage passes 5 GB (year 1) — after 12 months there is no S3 free tier at all, and storage is cumulative, so this arrives earlier than the user count suggests. |
| **~10,000 users** | **Cognito's 10,000 MAU allowance is exhausted.** This is the first genuinely material step change, because it is per-MAU with no ceiling. |
| **~65,000 users** | CloudFront crosses 1 TB egress/month. |
| **~12,000 users** | DynamoDB storage passes 25 GB. Beyond that, per-GB-month. |
| **Phase 8, any scale** | Model API spend, which at 1,000 users is already ~35× the AWS bill. **This, not AWS, is what makes the product cost money.** |

Practical reading of that table:

- **Up to 1,000 users the whole thing costs about the price of a coffee per month**, and
  the Apple Developer Program at $8.25/month amortised is the largest line item by a
  factor of three.
- The first architectural decision that costs real money is **shipping AI capture**, not
  adding users. Phase 8 needs a revenue answer before it needs a scale answer.
- The first AWS service that costs real money at scale is **Cognito**, at 10,000 MAU. That
  is a good problem, and by then the migration options (or the pricing conversation) are
  worth having.

Re-run this model when any assumption in §1 is contradicted by real data. The first time
the founder has a week of production metrics, replace the estimates in §1 with measured
values and recompute.
