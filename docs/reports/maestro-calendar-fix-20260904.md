# Calendar landing and Maestro correction — September 4, 2026

**Fixed and locally verified: final Maestro catalogue 19/19, web 32/32, and required checks passed.** The two previously unresolved cases passed on the corrected native build both in a clean focused run and in the full catalogue. This report extends, rather than rewrites, the historical [pagination/recurrence report](pagination-recurrence-followup-20260904.md) and [original pilot](native-e2e-pilot-20260904.md).

## A. Environment and tested identity

Repository: `/Users/yashgx/Documents/roc/rey/ordinarydays`; branch `codex/fix-ios-startup-maestro`; HEAD `dd22fd5e209bac848fc415fbb1bd9c52892e6b40` **plus preserved uncommitted pilot changes and this correction**. HEAD alone is not the tested source. No commit or push was made.

macOS 26.3 arm64; Xcode 26.6; iPhone 16 Pro simulator `F07733BB-622D-48CE-918A-3BDAE9045FF0`, iOS 26.5. Node 22.23.2, pnpm 9.15.9, Java 17.0.20.1, Maestro 2.10.0. Local-profile Release app `app.ordinarydays.ios.local`, version 0.1.0(1).

Final executable SHA-256: `8b49d9e830cc4932bdb33fa92ffef34c7982c887a794c1a05cbcc5376e2c2ec1`. Final JS bundle: `ad2a0da1c0775fb14a46433f977963eb305e70f04452c8f1c653197c383d87de`. [Installed build hashes](../generated/maestro-race-fix-20260904/final-build-hashes.json), [production source manifest](../generated/maestro-race-fix-20260904/final-build-source-manifest.json), [native compilation](../generated/maestro-race-fix-20260904/build-window-final.log). All 16 changed production files matched the scratch build source. The retained final app is `/private/tmp/od-maestro-race-fix-20260904/final-window.app`; the separately named `final.app` is an earlier race-only build.

Native tests used the isolated `od-main-maestro-pilot-20260904` table, API 3001, proxy 3000/control 8474, DynamoDB 8000 and MinIO 9000/9001. The web suite used its separate `od-main-e2e` table/API 3100. Development data was not reset. Seed cleanup and app clear-state isolate journeys. Native compilation ran in the existing scratch build checkout `/private/tmp/ordinarydays-maestro-20260904`.

## B. Baseline and attempts

The inherited full baseline was **17/19**: selection-race and dense-year failed. This turn first reproduced the original race failure, then corrected it before rerunning the catalogue. That intermediate catalogue was **18/19**, exposing the still-unfixed dense-year case. [Intermediate JUnit](../generated/maestro-race-fix-20260904/full-1/results.xml).

[Every completed native attempt](../generated/maestro-race-fix-20260904/attempts.md) links its JUnit and records failures as well as passes. One additional attempt, `old-build-red`, was aborted after installation failed because the Xcode shell environment was not loaded; it is not valid old-build evidence. The corrected `old-build-red-2` is a valid failure on the retained old app. A read-only driver probe also failed before the fixed port was configured. Diagnostic builds and rejected initial-index experiments are explicitly separate from final-build results.

Artifacts are archived in `docs/generated/maestro-race-fix-20260904/`, outside Playwright cleanup. Original logs and retained apps remain in `/private/tmp/od-maestro-race-fix-20260904/`.

## C. Classifications, causes, contracts and fixes

The governing contract is [Plans §1.3.4](../01-product/plans-and-lists.md#134-the-calendar-navigator): exact nonempty-day landing below the measured visible overlay; bounded window loading; immediate distant jumps; one stable estimate and a 256 ms recovery budget. Directional fallback applies only after coverage proves the selected day empty. This correction preserves those existing semantics; it does not introduce a new empty-date product rule.

| Failure | Evidence and classification | Correction |
| --- | --- | --- |
| Held-response race times out before the second date tap | Test timing/setup defect: normal Maestro taps wait for the animated loading indicator, consuming the application's 10-second request deadline. | Use the same running XCTest driver's hierarchy and touch endpoints to tap fresh accessible bounds while `Loading calendar` is present. Check loading before both taps. Pin driver port 22087 through the runner and CI invocation. No sleeps or increased application deadlines. |
| Wrong earlier date appears after rapid selection | Application defect: disposable layout trace captured a 568-point expanded-header offset being reused after the visible compact header measured 158. | Read the latest measured offset for bounded recovery; reattempt on layout changes only inside the existing budget. Guard immediate estimates as well as scheduled retries, cancel on user navigation, and supply measured trailing space for a short final card. |
| Negative title assertion fails despite correct visual landing | Test expectation defect: XCTest includes an old cell fully occluded by the opaque calendar. | Assert the previous title is absent **below** the calendar, paired with the requested date and distinctive content. The old app still fails this corrected assertion, proving it catches the real defect. |
| Dense year selection lands on intervening dates | Application defect: target rows were unmounted and estimated scrolling drifted while virtualized layout/header geometry changed. Initial-index and position-preservation experiments failed and were discarded. | On native, mount a render window near the selected target, initially retaining one preceding row. Keep the full projection and coverage untouched. Restore earlier rows in batches of 10 during backward user scrolling, with stable month identities and native visible-position preservation. Web retains its existing full section list. Unknown-boundary fetching still uses the full projection. |

[Layout trace](../generated/maestro-race-fix-20260904/landing-trace.log) and failed-run screenshots support the observed causes. The general frequency on physical devices is unknown. No claim is made that all pagination costs disappeared: full projection derivation and network serialization are outside this correction. Native SQLite/outbox and the preceding incremental-install/recurring-create fixes are preserved.

## D. Regression evidence and coverage

| Evidence | Regression caught |
| --- | --- |
| `header-red.log` → final Plans tests | Landing uses current compact/full header measurement rather than a captured old value. |
| `deadline-red.log`, `stable-estimate-red.log` → final tests | Late unmeasured callbacks cannot restart scrolling; only the first failure estimates an offset within the established budget. The clock is mocked. |
| `window-red.log`, `window-keys-red.log` → final tests | Distant target mounts without preceding history; stage/refresh resets remain valid; prepending retains stable section identity. |
| `old-build-red-2` → `final-1`, `window-focus`, final catalogue | Real rapid-selection journey: latest date/content wins, loading is observable, detail return and Today still work. |
| `full-1` dense failure → `window-1`, `window-focus`, final catalogue | Exact dense-year landing, backward restoration to a uniquely seeded activity two days earlier (outside the initial prefix), then destination reselection, detail return and Today. |

Plans component coverage is now 33 cases, plus four render-window cases, seven driver-helper cases and three runner cases. The final affected check ran 48 tests successfully. Existing parameterized date/race tests and instrumented bounded-request assertions remain active. Next month, six months, one year, distant past, year boundary, empty-window semantics, detail return and Today are covered by the retained calendar catalogue. Request assertions—not screenshots—check bounded loading. No new fixed performance threshold was invented.

Some intermediate fixtures/experiments failed before reaching their intended regression: raw accessibility field capitalization, an already-expanded calendar, and a stage-change cancellation test that unexpectedly passed. These are not claimed as valid application reds. All logs remain available, including rejected anchor experiments.

## E. Final checks and remaining gates

| Gate | Final result | Evidence |
| --- | --- | --- |
| Final complete native catalogue | **19/19 passed**, one final run, no retry | [JUnit](../generated/maestro-race-fix-20260904/full-2/results.xml), [log](../generated/maestro-race-fix-20260904/full-2.log), [artifacts](../generated/maestro-race-fix-20260904/full-2/artifacts) |
| Clean focused race + extended dense journey | **2/2 passed**, one final focused run | [JUnit](../generated/maestro-race-fix-20260904/window-focus/results.xml) |
| `pnpm verify` | **5,959 tests in 331 files**; lint, typecheck, dependency/forbidden-code/version checks passed; exit 0 | [Final log](../generated/maestro-race-fix-20260904/verify-6.log) |
| Final web catalogue | **32/32 passed**, exit 0 | [Log](../generated/maestro-race-fix-20260904/web-2.log) |
| Shared guards | **4/4 passed** | [Log](../generated/maestro-race-fix-20260904/guards.log) |
| Affected regression checks | **48 tests passed**, affected typecheck passed | [Tests](../generated/maestro-race-fix-20260904/window-final-checks.log), [Types](../generated/maestro-race-fix-20260904/window-final-types.log) |
| Native Release compilation | Passed; final build installed and hashes recorded | [Build](../generated/maestro-race-fix-20260904/build-window-final.log) |
| `git diff --check` | Passed | Checked after final source and report edits |

These are final-build results after the earlier failures in the attempt ledger, not an unqualified description of all attempts. Six broad verify invocations were retained: attempts 1, 3, 4, 5 and 6 passed their respective source states; attempt 2 failed an implicit-any test fixture and was corrected. Two web runs passed 32/32. Intermediate test/experiment logs remain archived.

| Final native case | Result | Seconds |
| --- | --- | --- |
| P2-55 occurrence completion survives offline replay and process death | passed | 35.394 |
| Calendar dense-year: exact day, detail return and Today | passed | 27.373 |
| P3 native attachment projection survives relaunch | passed | 36.697 |
| Calendar selection-race: exact day, detail return and Today | passed | 18.599 |
| P2-37 foreground UP NEXT ticker | passed | 73.416 |
| P3 native schedule reconciles Plans | passed | 13.493 |
| Calendar year-boundary: exact day, detail return and Today | passed | 14.172 |
| Calendar one-year: exact day, detail return and Today | passed | 14.198 |
| P2-37 snooze one recurring occurrence | passed | 15.817 |
| New recurring Task appears beyond reminder coverage without refresh | passed | 48.754 |
| P3 recurring occurrences remain visible in Past | passed | 6.812 |
| P3 native Prep parent reconciliation | passed | 11.296 |
| Calendar six-months: exact day, detail return and Today | passed | 16.664 |
| Calendar distant-past: exact day, detail return and Today | passed | 15.476 |
| P2-55 completing today leaves tomorrow's recurring occurrence live | passed | 12.453 |
| P3 native source List reconciliation | passed | 41.858 |
| Calendar next-month: exact day, detail return and Today | passed | 15.375 |
| P2-37 add and complete | passed | 13.885 |
| P3 native Plans reflects local creates and completion | passed | 26.494 |


`pnpm e2e:native` runs the standard catalogue with the required driver port. A focused run uses `pnpm e2e:native --flow apps/mobile/e2e/calendar-selection-race.yaml`. The final complete run supplied `--flow . --config /private/tmp/od-maestro-race-fix-20260904/full-catalogue.yaml`, simulator ID, JUnit output and artifact directory; that config retains all 19 cases and continues after failures for reporting.

The previous follow-up's API integration run passed 612 tests; it was **not rerun this turn**, since API/storage source was unchanged by this correction. Final `pnpm verify` includes API unit tests. Physical iPhone acceptance, Android, CI, merge and release gates were **not run**. Local simulator acceptance is not physical-device acceptance.

## F. Changed files and review

This turn changed `PlansScreen.tsx` and its tests; added `calendarListWindow.ts` and tests; changed the selection-race and dense-year flows plus their seed script; added the in-flight driver helper and tests; added `e2e/run-native.mjs` and runner tests; and updated `package.json` plus the executable Maestro command in `.github/workflows/mobile.yml`. [Exact file hashes](../generated/maestro-race-fix-20260904/changed-file-hashes.json), [Plans turn-start delta](../generated/maestro-race-fix-20260904/PlansScreen-this-turn.patch).

Other working-tree changes were preserved, including AGENTS.md, CONTEXT-MAP.md, agent-playbook.md and docs/agents/workflow.md. No workflow or skill instructions were edited in this experiment. The old direct CLI instructions lack the fixed driver port; use the wrapper above. This documentation mismatch is recorded rather than silently changing prohibited instructions.

Independent Spec and Standards reviews found and resolved late-callback guards, runner argument handling, deterministic clock fixtures, stable prepend keys, gesture ownership and a backward-coverage gap. Final reviews reported no outstanding actionable code findings. [Review record](../generated/maestro-race-fix-20260904/review.md).

## G. Workflow observations

The user's question prompted continuation of unfinished native work; no further clarification or approval questions were needed. Early padding-only and initial-index hypotheses were insufficient. Capturing layout evidence earlier would have reduced rebuilds. Two driver integration mistakes caused avoidable setup failures. The complete catalogue caught dense navigation after an isolated race pass. Repeated broad verification during abandoned experiments added work; focused native verification was more discriminating. Independent review caught meaningful lifecycle and test-coverage omissions.

Native attempt timestamps are retained in JUnit (first baseline approximately 22:23 local September 4). They provide an evidence span, not a precise total session runtime. Token usage is unavailable. No timing or cost estimate is presented as measured fact.

## H. Proposed improvements — not applied

1. Document the port-pinned native wrapper after the instruction-edit restriction is lifted; observed driver-port failures justify it.
2. Capture requested date, current header measurement and bounded scroll attempts in disposable diagnostics before another layout experiment; the stale-offset trace was decisive.
3. Require focused native execution before broad checks for virtualization changes, then one final complete catalogue; isolated passes missed dense behavior.
4. Preserve a turn-start source/build manifest and archive evidence outside test cleanup from the start; multiple builds made identity tracking essential.
5. Keep unique date/content seeds and explicit backward restoration in distant-navigation coverage; a one-day-back assertion initially stayed inside the retained prefix and would have overstated coverage.
