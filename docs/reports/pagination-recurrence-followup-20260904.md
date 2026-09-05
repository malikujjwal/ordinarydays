# Pagination and recurring-create follow-up — September 4, 2026

**Status: partial completion.** The incremental SQLite installation and recurring-create cutoff are corrected with regression evidence. The original Maestro selection-race case remains failing. The final full native catalogue also exposed an intermittent dense-calendar landing failure; this report does not claim overall native acceptance.

## A. Environment and exact build

- Repository `/Users/yashgx/Documents/roc/rey/ordinarydays`, branch `codex/fix-ios-startup-maestro`, HEAD `dd22fd5e209bac848fc415fbb1bd9c52892e6b40` plus existing uncommitted pilot work and this six-file follow-up. No commit or push.
- macOS 26.3 arm64, Xcode 26.6, iPhone 16 Pro simulator `F07733BB-622D-48CE-918A-3BDAE9045FF0`, iOS 26.5, local-profile Release app `app.ordinarydays.ios.local` 0.1.0(1).
- Node 22.23.2, pnpm 9.15.9, Java 17.0.20.1, Maestro 2.10.0. Exact output: [environment](../generated/pagination-followup-20260904/environment.json).
- Isolated native table `od-main-maestro-pilot-20260904`, API 3001, proxy 3000/control 8474. Web tests use their separate table/API 3100. Developer table was not reset.
- Final app executable SHA-256 `9f56a948665362a11a37f636ad8f1bf5cb36740836f76126399dcd7489b93dc9`; JS bundle `68311ea2c195138bd0c5f1e34f095e4440d9313c7d956f68171e3bdcee433e57`. [Build identity](../generated/pagination-followup-20260904/build-identity.json), [production source manifest](../generated/pagination-followup-20260904/build-source-manifest.json).
- A temporary diagnostic build was separately compiled after the complete catalogue. Its two console probes were confined to the scratch workspace, then removed; the retained final app was reinstalled. Diagnostic success is not substituted for final-build evidence.

## B. Baseline and retained artifacts

The preceding pilot's full baseline/final chronology remains in [native E2E pilot report](native-e2e-pilot-20260904.md). Its final native build passed 17/18 cases, with `calendar-selection-race` failing. The matching recurrence cutoff reproduced on both current and pre-pilot source: [earlier diagnosis](../generated/recurrence-cutoff-diagnosis-20260904/README.md).

This follow-up captured a fresh native recurrence red: after creating a daily Task offline while Plans already held its projection, September 12 did not become a visible destination. The same flow on the corrected build passed, including process death and offline relaunch. The first draft of that flow failed earlier because Repeat was offscreen behind the keyboard; dismissing the keyboard and scrolling to the accessible control corrected setup before the functional red was recorded.

Evidence root: `docs/generated/pagination-followup-20260904/`. Original working artifacts are also retained at `/private/tmp/od-pagination-followup-20260904`. These locations are outside Playwright's cleanup directory.

## C. Classifications, root causes, contracts and corrections

| Finding | Classification and evidence | Correction / status |
| --- | --- | --- |
| Accumulating Plans page installation rewrites older dates | Application performance defect. SQLite audit triggers observed delete/reinsert activity for an unrelated older date. | `PlansRepository.install` now reads state, coverage metadata and overlapping partial dates only; it replaces authoritative ranges and merges returned partial dates by identity. Unrelated dated rows stay in SQLite. Empty authoritative responses still remove stale rows. |
| Newly created daily Task/Plan stops after the first week | Application defect predating the prior pilot. Creation projected only retained Agenda reminder coverage (eight inclusive dates), while Plans already claimed broader coverage. | Project a newly supplied recurrence through the union of retained Agenda and Plans intervals, in at most 62-day expansion chunks. Unknown gaps remain unmaterialized. The shared helper serves direct creation and `Plan this item`. Activity, outbox and projections remain under the existing native transaction. |
| Original held-response calendar race | Test-driver timing problem remains unresolved. The iOS driver waits for screen animation around taps; the loading wheel remains animated and the app's 10-second deadline expires before response release. | Two supported tap-sequence experiments failed and were restored. The original case and assertions remain present. No timeout increase, skipped failure or modified installed Maestro binary. |
| Dense-year selected September 15, rendered September 4 near the top | Observed native navigation failure; exact cause unproven. The full-run screenshot and tap log establish disagreement between requested and visible dates. | A diagnostic isolated run passed, without useful console telemetry. A stable-estimate/recovery timing issue is a hypothesis, not an established cause or a shipped correction. A clean exact-build repeat also passed; the full-suite failure remains open. |

Contract references: `plans-and-lists.md` §1.3 Upcoming requires a recurring row per date in the window; §1.3.4 requires calendar/list agreement from effective local state, bounded window loading, exact nonempty-date landing and one stable estimate within 256 ms recovery; §6/§6.1 treats the List-item bridge as ordinary Plan creation. `tech-stack.md` §3.4 invariant 4 permits projection from the supplied create rule. Native transaction/outbox ownership remains unchanged.

The optimization does **not** eliminate the UI's full projection reads, all rendering cost, or contention in the serialized network lane. No end-to-end phone scrolling speed multiplier or performance-budget claim is made.

## D. Regression evidence and coverage mapping

- `pagination-red.log`: the untouched-date write audit failed before correction (1 failed, 6 passed). `pagination-green.log`: 7 passed after correction.
- `pagination-adjacent.log`: one invalid Past fixture omitted required coverage metadata. Corrected fixture in `pagination-adjacent-2.log`: 124 passed across Plans and sync suites. This was test setup, not a product defect.
- `recurrence-red.log`: direct Task and Plan both failed at the first date beyond the reminder window (2 failed, 8 passed). `recurrence-green.log`: 170 passed across Plans, activity transactions and sync.
- Review found the sibling List-item path. `linked-recurrence-red.log`: that path failed (1 failed, 10 passed); `linked-recurrence-green.log`: 171 focused tests passed after sharing the create projection.
- Final parameterized persistence coverage verifies Task, Plan and linked Plan occurrences on September 12, October 6 and September 15 of the following year; no rows in the unknown intervening gap; acknowledgement followed by a stale empty Plans response; and reconstructed-reader durability without duplicates. `ack-regression.log`: 11 passed before final fixture typing corrections; final required checks include the corrected fixture types.
- New executable native journey: `apps/mobile/e2e/recurring-create-window.yaml`. It opens cached Plans, creates a daily Task offline, selects day nine, asserts the date and distinctive title, restarts offline, and asserts the same date/title. This catches the creation-after-coverage gap that prelaunch recurring fixtures missed.
- Native attempts: `recurrence-native-red` failed at setup; `recurrence-native-red-2` failed at the intended day-nine assertion on the old build; `recurrence-native-green` passed on the final build; the full catalogue repeated that journey successfully after an isolated table reset.
- Existing controlled-response lower-level calendar tests still exercise superseded request resolve/reject and loading/error ownership. They do not certify the failing native Maestro race.

## E. Commands, attempts and remaining gates

| Command / gate | Results |
| --- | --- |
| `pnpm verify` | Attempt 1 passed before the linked-path extension; attempt 2 failed on new test fixture typings; attempt 3 passed the final source: **5,940 tests, 328 files**, lint, typechecks, dependency checks, forbidden-code and version checks. |
| `pnpm test:int` | Passed: API 612 integration tests; three Turbo tasks successful, two cached. |
| `pnpm --filter @od/shared test:guards` | Passed, four guards. |
| `git diff --check` | Passed. |
| Local-profile Release `expo run:ios` | Final build passed, zero errors and one warning. Separate diagnostic compilation also passed. Compilation alone is not journey acceptance. |
| Final web export + Playwright catalogue | **32/32 passed**, zero skipped, unexpected or flaky; one web test attempt. |
| Final full Maestro catalogue | **17/19 passed**, two failures below. No retries disguised as passes. |
| Physical iPhone / Android / CI / merge | Not run. No physical-device acceptance claimed. |

Full native command: `maestro --device F07733BB-622D-48CE-918A-3BDAE9045FF0 test --config /private/tmp/od-pagination-followup-20260904/full-catalogue.yaml --format junit --output /private/tmp/od-pagination-followup-20260904/full-1/results.xml --test-output-dir /private/tmp/od-pagination-followup-20260904/full-1/artifacts .`

[JUnit](../generated/pagination-followup-20260904/full-1/results.xml), [full-run artifacts](../generated/pagination-followup-20260904/full-1/artifacts), [web summary](../generated/pagination-followup-20260904/web-summary.json), [required checks](../generated/pagination-followup-20260904/verify-3.log).

| Native case | Result | Seconds |
| --- | --- | --- |
| P2-55 occurrence completion survives offline replay and process death | passed | 24.159 |
| Calendar dense-year: exact day, detail return and Today | failed | 31.102 |
| P3 native attachment projection survives relaunch | passed | 34.792 |
| Calendar selection-race: exact day, detail return and Today | failed | 36.598 |
| P2-37 foreground UP NEXT ticker | passed | 108.958 |
| P3 native schedule reconciles Plans | passed | 13.531 |
| Calendar year-boundary: exact day, detail return and Today | passed | 14.224 |
| Calendar one-year: exact day, detail return and Today | passed | 14.442 |
| P2-37 snooze one recurring occurrence | passed | 16.556 |
| New recurring Task appears beyond reminder coverage without refresh | passed | 48.254 |
| P3 recurring occurrences remain visible in Past | passed | 6.67 |
| P3 native Prep parent reconciliation | passed | 11.278 |
| Calendar six-months: exact day, detail return and Today | passed | 18.641 |
| Calendar distant-past: exact day, detail return and Today | passed | 15.477 |
| P2-55 completing today leaves tomorrow's recurring occurrence live | passed | 12.377 |
| P3 native source List reconciliation | passed | 41.205 |
| Calendar next-month: exact day, detail return and Today | passed | 17.051 |
| P2-37 add and complete | passed | 13.748 |
| P3 native Plans reflects local creates and completion | passed | 26.357 |

The race had two additional failed follow-up experiments (`race-1`, shortened sequence; `race-2`, supported element-relative taps), then failed unchanged in the complete catalogue. Neither experiment is shipped. The dense case failed in the full catalogue and passed in a separate diagnostic build; its clean non-diagnostic repeat also passed (21 seconds). This is an intermittent full-suite failure followed by isolated passes, not an unqualified pass or a demonstrated correction.

## F. Changed files and review

Six follow-up source/test files:

- `apps/mobile/src/lib/sqlite/plansRepository.ts`
- `apps/mobile/src/lib/sqlite/plansRepository.test.ts`
- `apps/mobile/src/lib/sqlite/agendaRepository.ts`
- `apps/mobile/src/lib/sqlite/activityTransactions.ts`
- `apps/mobile/e2e/scripts/setup.js`
- `apps/mobile/e2e/recurring-create-window.yaml`

[Follow-up patch](../generated/pagination-followup-20260904/followup.patch), [file hashes](../generated/pagination-followup-20260904/followup-files.json), [review record](../generated/pagination-followup-20260904/review.md). The fixed point is the captured starting working tree, preserving the prior pilot and other agents' changes; it is not a claim that HEAD alone contains this tested build.

Independent Standards review found no actionable findings. Independent Spec review identified the sibling bridge and acknowledgement/stale-response evidence gaps; both were addressed and the reviewer found no remaining source findings. Native failures remain open despite source review.

This report and ignored diagnostic artifacts are additional deliverables. User-owned AGENTS, context map, playbook and workflow changes were preserved. Workflow/skill instructions were not modified.

## G. Workflow observations

No new user clarification or approval question was required. Red-first testing exposed the target cutoff and the sibling creation path. The first native draft needed a keyboard/scroll correction, and added fixture types needed correction; all failed attempts remain in the logs. Two driver experiments did not fix the race. A full-suite run exposed a dense-calendar failure that the previous pilot and an isolated diagnostic run had passed, demonstrating why isolated passes cannot replace catalogue evidence.

Exact total conversation time and token usage are unavailable. Logs retain command timestamps and durations; no inferred token figure is presented.

## H. Proposed improvements — not applied

1. Require creation-after-cache and offline-relaunch coverage for recurring projection work. Prelaunch seeding alone missed the demonstrated first-week cutoff.
2. Retain SQLite write-audit checks for pagination locality. They prove bounded affected-row work without inventing a wall-clock performance budget.
3. Treat unresolved native-driver synchronization limits as a separate test-infrastructure issue, preserving assertions and app deadlines. Controlled-response integration tests should accompany, not silently replace, native journeys.
4. Add opt-in native landing telemetry in a future scoped change so target identity, measurement progress and final viewport can be correlated. This run's temporary console probes did not produce usable telemetry.
5. Keep diagnostics outside Playwright output directories and record source/bundle hashes, full-run failures and clean repeats separately.
