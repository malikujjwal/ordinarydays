# Ordinary Days native E2E/calendar workflow pilot — 2026-09-04

**Status: partially complete; two explicit limits remain.** Final native build 6 passes **17/18** flows, including all 11 original cases and six new calendar journeys. Final web passes **32/32**, and repository verification passes **5,935 tests** plus required checks. The held-response Maestro race remains failed; exact empty-date behavior requires the unresolved contract decision below. No push, merge, workflow-instruction edit, or physical-device acceptance was performed. Observations and hypotheses are distinguished below.

## A. Environment and tested source/build

- Repository: `/Users/yashgx/Documents/roc/rey/ordinarydays`; branch `codex/fix-ios-startup-maestro`.
- Base revision: `dd22fd5e209bac848fc415fbb1bd9c52892e6b40`, plus the uncommitted pilot patch. The base revision alone is **not** the tested final source.
- macOS 26.3 (25D125), Apple Silicon; Xcode 26.6 (17F113), iOS simulator SDK/runtime 26.5.
- iPhone 16 Pro simulator: `F07733BB-622D-48CE-918A-3BDAE9045FF0`.
- Node 22.23.2, pnpm 9.15.9, Java 17.0.20.1, Maestro 2.10.0. Docker engine 29.7.2 was available from setup.
- Native profile `local`, configuration `Release`, bundle `app.ordinarydays.ios.local`, version 0.1.0 (1), minimum iOS 15.1.
- Compilation used `/private/tmp/ordinarydays-maestro-20260904`, an isolated dependency/native-project copy. This avoided Expo-generated native/package changes in the shared checkout. Changed production files were copied explicitly; the build source manifest records their SHA-256 values.
- Final build 6 executable SHA-256: `b8c785130494beef9d270f3cb456b9df65875c79c29d2f78d2b0ff65b1f4a69a`; embedded `main.jsbundle`: `1e4d09a73acd6fb8f48f1ee5561c4013a855bcdfbab6db598ee53ca1be146e98`. Earlier build-5 identity remains retained separately.
- Native proxy: API-facing port 3000, control 8474, upstream API 3001. Native tests use isolated DynamoDB table `od-main-maestro-pilot-20260904`, seeded profile `usr_local_dev`, local MinIO and `od-media-local`. The developer table was not reset. Web uses its existing separate `od-main-e2e` table and API port 3100.
- The existing **Compile app on macOS** task was consulted. Its owner reported no completed build/provenance to reuse and left the simulator/ports available. Baseline provenance therefore comes from the installed bundle hashes and prior task evidence, not an assumed build-owner revision.
- Other-task changes in `AGENTS.md`, `CONTEXT-MAP.md`, `docs/04-conventions/agent-playbook.md`, and `docs/agents/workflow.md` were excluded and preserved.

Evidence is preserved in [the artifact directory](../generated/maestro-pilot-20260904/) with a [file index](../generated/maestro-pilot-20260904/index.md), and in `/private/tmp/od-pilot-evidence-20260904`. Exact identity: [build-6-identity.json](../generated/maestro-pilot-20260904/build-6-identity.json), [build source manifest](../generated/maestro-pilot-20260904/build-6-source-manifest.json), [all changed source/test hashes](../generated/maestro-pilot-20260904/changed-files.json), and [tested patch](../generated/maestro-pilot-20260904/tested-working-tree.patch). Final patch SHA-256: `de85f0cf3354d133651008c01e2c4f48430ef30aeb6564deed4d34c26f9f82eb`. All 13 production-file hashes match build 6. The original build-5 patch and manifest are retained with the `build-5-` prefix; its patch SHA-256 is `1a25c3540902d789e4e55c600311c9d584b4cd2f28a065c27e4e0a4b71942bd4`.

## B. Baseline and evidence retention

The original 11-flow catalogue ran before pilot production changes: **7 passed, 4 failed**.

| Original case | Baseline | Failure observed |
|---|---|---|
| add-and-complete | Pass | — |
| offline-queue-relaunch | Pass | — |
| up-next-ticker | Pass | — |
| schedule-plans-reconciliation | Pass | — |
| recurring-past-history | Pass | — |
| prep-parent-reconciliation | Pass | — |
| recurrence-stabilization | Pass | Later failed an offscreen assertion in a denser seeded run |
| attachment-native-projection | Fail | Native photo-selection expectation |
| snooze-occurrence | Fail | Snooze sheet not found after swipe |
| source-list-reconciliation | Fail | Delete confirmation not found after swipe |
| plans-live-projection | Fail | Completed Plan expected a Task-style checkbox/label |

Baseline installed executable hash was `0e25aca849e144cc1aedfeea0b8d129372f55ef5dc0296397bf540b731cc0241`; bundle hash `ad0f7408dba9402d493ee72c0f866f63ab80280b775992bfcdbf9562a627e43b`. The baseline included the prior native Expo Head correction; it was not Expo Go.

**Evidence loss, explicitly disclosed:** the first web command used Playwright's default `test-results` directory. Playwright cleared it, deleting the earlier pilot screenshots/JUnit/unit-log files stored under that directory. This was an agent workflow error. Original Maestro execution logs survived in `~/.maestro/tests` and were copied to `maestro-logs/`; later artifacts were moved outside the cleanup root. The original screenshots are not claimed to have survived. Early results below are supported by the surviving logs and contemporaneous observations, with this limitation. `surviving-results/` retains what remained, including the four-case isolated run and browser-launch errors.

The sparse calendar probes passed next month, six months, one year, and distant past on the original build. A **dense daily series spanning a year** reproduced the calendar bug: selecting September 15, 2027 left the visible list around January 20, 2027. Thus the evidence does **not** establish a fixed month-distance threshold; density and virtualized landing are relevant. The dense pilot then passed on build 1 with one exact-window request.

## C. Classification, contracts, root causes, corrections

Canonical references: [Plans §1.3–1.3.4](../01-product/plans-and-lists.md), [Today §5.3](../01-product/today-and-tasks.md), [interaction U3 and §6.2](../01-product/interaction-contract.md), [design motion](../04-conventions/design-system.md), [testing §5, §6.1, §8.2](../04-conventions/testing.md), and [definition of done](../03-implementation/definition-of-done.md).

| Finding | Classification and observed cause | Correction/evidence |
|---|---|---|
| Distant calendar fetch traversed intervening months | Application defect. `fetchStageRange` began at the held Upcoming extent instead of the requested visible range; the one-year lower-level case issued six windows. §1.3.4 requires the exact visible window. | Fetch only missing parts of the requested window, bounded by the existing maximum window size. Dense native pilot and request instrumentation verify distance-independent loading. |
| Unfetched intervals were labelled empty | Application defect. Grouping occupied dates fabricated a “nothing planned” gap across disjoint coverage. Unknown is not empty under §1.3.4. | Preserve explicit unloaded boundaries; never label unknown dates empty. User scrolling or the accessible boundary action loads a bounded page. |
| Bounded fetch initially advanced ordinary scrolling beyond unloaded months | Regression caught by independent review during this pilot. Web and SQLite merged the distant `nextFrom` into ordinary pagination. | Shared `mergeWindowProgress` preserves the contiguous cursor, advances it only when a response covers that cursor, and keeps rendered extent monotonic. A boundary makes intermediate content reachable before treating it as loaded. Calendar landing does not itself drain the middle; no synthetic request beyond a terminal right edge. |
| Previous month's loading/error state leaked into the current calendar window | Application defect. State remained set when the requested window changed to covered data. | Clear obsolete status on need changes; existing abort/ownership checks prevent obsolete success/failure callbacks taking ownership. |
| Left full swipe could perform both completion and snooze | Application defect. Both mounted action panels used absolute translation, so the opposite panel could also cross its threshold. U3 permits the first action on the swiped side only. | Use signed translation for each side. Actual native component regression records `complete` plus `snooze` before correction and only `snooze` afterward. |
| Native swipe actions failed to settle/close correctly | Application defect. Task/List swipe wrappers used library spring defaults instead of the canonical motion spring. Native screenshots showed an action panel behind the Task after snooze; List delete never reached confirmation in baseline. | Apply the existing motion spring and system reduced-motion setting to both wrappers. List deletion and the complete List journey passed afterward. |
| Snooze annotation not available to native automation/accessibility | Application accessibility defect plus incorrect test access path. Server and SQLite both retained original/effective time; screenshot showed the arrow annotation, but the accessible row body said only effective time and Daily. | Add the original-to-snoozed change to the row body's spoken label; test the actual accessible control. Keep exact unique fixture/time assertions. No scheduling semantics changed. |
| Plans completion expectation | Incorrect test expectation. Completed Plans use outcome verbs; they do not acquire a Task checkbox. | Assert the Plan's `Done` state and undo outcome, preserving Task assertions. |
| Attachment flow | Incorrect test expectations and an environment prerequisite. Single-selection PHPicker returns immediately; the viewer pager is the exposed native node; deletion should remain deleted after relaunch. Later owner actions were unavailable because `/v1/me` was 404. | Use the native picker label/pager, verify upload survives relaunch, then verify deletion survives relaunch. Seed the isolated profile. Passed full native journey. |
| Add List flow | Incorrect test expectation. §4.1 requires the “Create new list” choice before presets. A subsequent title failure came from tapping into the middle of an autofocused prefill before backspacing. Count is exposed as `title, 1 item`. | Add explicit choice; erase from existing autofocus/end position; assert exact fixture title/count. Native full journey passed. Same stale choice corrected in the web Trip case. |
| Tomorrow occurrence checks | Test visibility/isolation problem. A date container could be partly visible while its fixture row was below the viewport; independent title/time selectors could match unrelated rows. | Navigate to tomorrow and scroll conditionally to the combined fixture outcome within `plans-day-tomorrow` using `childOf`. No assertion removed. |
| Trip rename was falsely accepted by its test | Test coverage/setup defect. The final API rename omitted required concurrency/idempotency headers and its 400 response was ignored. | First assert successful response and saved title (focused attempt 9 failed); then supply current `updatedAt` as `If-Match` plus a fresh idempotency key. Final full web catalogue passes with these stronger assertions. This proves API persistence, not UI rename interaction. |
| Ticker initial UP NEXT | Test fixture timing problem. Setup ran at 19:30:59.460 and seeded its first item for 19:30; by launch the correct UP NEXT was the second item at 19:31 (Today §2.1). | Seed the next two minute boundaries; retain the epoch-based foreground wait. Two parameterized script regressions failed before and passed after correction. No app clock or timeout change. The fixture explicitly rejects the final two minutes of a day. |
| Held calendar race | Harness/environment timing blocker. Maestro spends animation-settle time while the request is held; the app's existing ten-second request deadline expires before the loading assertion. | Kept the failing executable case and strengthened destination rejection. No increased app timeout, fixed sleep, automatic retry, or skip. Lower-level stale-response tests remain the race evidence. |
| Web Trip List disappeared after page reopen | Application cache-freshness defect, §4.2. The table and actual service had the List and three items. A later diagnostic captured the restored detail with `sourceLists: []`, a recent `dataUpdatedAt`, and `isInvalidated: false`; no detail HTTP request occurred on return. A recently saved snapshot was treated as proof of current relationships. | Mark only restored web Activity/occurrence details invalidated while preserving cached data for initial paint. Actual restore/read regressions fail before and pass after. The existing one-second persistence throttle explains how an earlier snapshot can survive abrupt page navigation, but the exact lost-save ordering was not separately instrumented. Native SQLite ownership and unrelated cached queries remain unchanged. |

The Maestro timing diagnosis is corroborated by its [iOS driver source](https://raw.githubusercontent.com/mobile-dev-inc/Maestro/main/maestro-client/src/main/java/maestro/drivers/IOSDriver.kt): an initial 3,000 ms static-screen wait precedes use of the supplied timeout. Installed-run logs independently show those waits. The source link is current upstream, not a claim that a locally rebuilt Maestro fork was tested. [Relational selectors](https://docs.maestro.dev/reference/selectors/relational-selectors) support the fixture scoping used here.

### Calendar path traced

`CalendarNavigator.select(date)` sends the wall date through `onSelectDate`; `PlansScreen` owns the pending `landing`. The navigator separately derives the visible month grid and stage-clipped missing range. After the existing settle interval, `useCalendarNavigator` requests that range with an abort signal. `usePlans.loadRange` installs it through native SQLite (or the existing web store path), and the projected store produces dated sections. The landing effect waits for an exact date row; a neighbor is eligible only once coverage proves the selected date empty. The existing native adapter adds the section-header offset, jumps without animation, and accounts for the calendar overlay. Those adapter corrections were already in the base revision; this pilot corrected the excessive fetched/rendered extent and preserved the unloaded middle/pagination cursor. The pending landing is replaced by later selections; hook tests exercise obsolete response ownership. Native response-order acceptance remains blocked as described above.

### Product decision still pending

§1.3.4 explicitly permits a covered-empty day to land on a neighboring populated card. The requested exact empty-date destination conflicts with that clause. A proposal was presented: selecting any eligible empty date keeps that exact date, displays “Nothing planned for this day,” loads only its bounded window, and preserves nearby scrolling. Approval to amend the canonical interaction has not arrived. No empty-day behavior or canonical clause was changed. The empty-day Maestro case is therefore **not implemented or claimed passed**.

## D. Regression evidence and coverage mapping

New executable calendar files use unique seeded target, neighboring, and Today titles, fresh app state, and cleanup hooks. They assert the destination date **and** its content, open detail and return, then return to Today. The dense case adds a daily series rather than assuming distance alone reproduces the bug.

| Case | Expected outcome / defect caught |
|---|---|
| calendar-next-month | Exact next-month date/content; ordinary month selection |
| calendar-six-months | Exact six-month destination; only the visible requested window |
| calendar-one-year | Direct one-year destination; no intervening-window chain |
| calendar-distant-past | Correct historic date/content in Past |
| calendar-year-boundary | January 1 of the next year; year arithmetic and eligibility |
| calendar-dense-year | Exact one-year landing with dense intervening recurrence; original pilot failure |
| calendar-selection-race | Later neighboring selection owns landing while the window is held; rejects earlier target content. Currently blocked at loading assertion. It is a same-window native case, **not** a cross-window response-order proof. |
| Empty date | Pending product decision; no executable coverage claimed |

Lower-level coverage includes parameterized date/month/year/leap-boundary arithmetic, five bounded fetch ranges, obsolete success/rejection responses, covered-window status reset, web hook pagination across a distant jump, SQLite continuation persistence, overlap/older/disjoint/terminal cursor merges, unknown-boundary projection, and boundary loading/failure/explicit retry/unmount behavior. The actual `AgendaRow` and native `SwipeableRow` components have accessibility/directional regression assertions.

The proxy retains only Plans mode/from/through, not headers or arbitrary query values. `assert-calendar-requests.js` checks **all** recorded Plans requests; unexpected modes cannot be filtered away. Proxy tests cover recording and explicit hold/release. Bounded loading is established by request assertions and integration-level hook tests, not screenshots or an invented performance threshold.

Retained red/green pairs include `pagination-red-2.log` (SQLite), `pagination-red-5.log` (web hook) → `pagination-green.log` (14 passed); `boundary-red.log` → `boundary-green.log` (35 passed); `snooze-a11y-red.log` (one real regression failure) → `snooze-a11y-green.log` (51 passed across affected files). Earlier pagination red attempts exposed fixture URL/schema/async-harness errors and are retained separately; they are not presented as application red evidence. `ticker-red.log` records two failing setup-minute regressions (nine existing tests passed); `ticker-green.log` passes all 11. `boundary-state.log` covers 31 tests including the actual boundary state machine and screen composition.

## E. Commands, attempts, remaining gates

### Native attempt ledger

| Attempt | Result / purpose |
|---|---|
| Baseline original catalogue | 7/11 pass, four failures |
| Gesture probe, original build | 0/2 pass; animation wait alone did not fix swipe failures |
| Calendar baseline initial invocation | YAML name parse error; no journey ran |
| Sparse calendar baseline corrected invocation | 4/4 pass |
| Dense calendar baseline | 0/1 pass; exact distant date absent |
| Build 1 dense pilot | 1/1 pass; exact one-window request |
| Remaining build 1 | 0/3 pass; viewer/badge/completed-Plan expectations |
| Expectations build 1 | 1/3 pass (Plans); attachment owner and snooze detail expectations remained |
| List build 2 | Delete fixed; later missing Create-new-list choice failed |
| Isolated build 2 | 0/4 pass; final attachment state, race loading, tomorrow visibility, List prefill |
| Isolated attempt 2 | 2/4 pass (attachment, snooze); race and List prefill still failed |
| List attempt 3 | Title/items worked; unscoped `1 item` assertion failed |
| Catalogue build 4 initial invocation | Asset outside Maestro workspace root; no journeys ran |
| Catalogue build 4 corrected root invocation | 15/18 pass; race, snooze accessibility, recurrence visibility failed |
| Snooze diagnostic | Failed accessible annotation assertion; server/SQLite/screenshot established correct visual state |
| Catalogue build 5 | 16/18 pass; held race and setup-minute ticker rollover failed. Snooze and recurrence corrections passed. |
| Catalogue build 5, clean-table repeat after ticker correction | 17/18 pass; only held race failed. All original 11 flows and six other new calendar cases passed. |
| Catalogue build 6, final clean-table run | **17/18 pass**; only held race failed. All original 11 and six other new calendar cases passed again. [JUnit](../generated/maestro-pilot-20260904/catalogue-build-6/results.xml), [case matrix](../generated/maestro-pilot-20260904/final-native-cases.json). |

Builds 1 and 2 succeeded. Build 3 was interrupted after a source-copy command used the scratch directory as if it were the Git checkout; it is not a verification build. Build 4 succeeded. Builds 5 and 6 each succeeded with zero compile errors and one existing warning. The commands and logs distinguish these attempts. Clean-table seed attempt 1 failed before mutation because `MEDIA_BUCKET` was missing; attempt 2 supplied it and successfully reset only the isolated native table to 24 activities plus the local profile.

### Required checks

- `pnpm verify`: original run passed but its log was lost; retained runs `verify-2.log`, `verify-3.log`, `verify-4.log`, and final `verify-5.log` passed. Final run reports **5,935 tests in 328 files** across mobile/UI/shared/API/infra, including coverage gates, plus lint, typechecks, dependency rules, forbidden-pattern and version checks.
- `pnpm test:int`: original passed but log was lost; final retained `integration-2.log` passed (three Turbo tasks successful; API **612 tests in 30 files**, other tasks cached).
- `pnpm --filter @od/shared test:guards`: passed, four tests.
- `pnpm gen:openapi:check`: first attempt failed on sandbox IPC; escalated rerun passed with no generated diff.
- Web first run could not launch the missing Chromium executable; 22 failed IDs survive, complete initial summary does not. Chromium was installed.
- Web full attempt 2: 29 passed, two downstream serial skips, one stale List-choice failure.
- Web Trip attempt 3 after choice correction: failed later on missing source List.
- Web Trip attempt 4: passed without another application change; **pass-on-rerun**, not an unqualified fix. Trace retained.
- Web full attempt 5 (then-final bundle): 29 passed, one Trip failure, two downstream serial skips. These were **not** permanently skipped tests: `mode: serial` withheld the later standalone-List and undated-Plan cases after the Trip failure.
- Web Trip diagnostic attempt 6: failed again; `web-trip-6.log` records the stale restored cache and absence of a detail response. Temporary diagnostic logging was removed afterward.
- `web-cache-red.log`: two failing fresh-cache restoration cases, four existing tests passed. `web-cache-green.log`: 27 passed across persistence, legacy migration, and native detail hooks.
- Web export 7 and final native build 6 include the cache correction.
- Web Trip attempt 7: passed after the cache fix.
- Web full attempt 8: **32/32 passed**, no skips. Log review nevertheless found the previously ignored rename 400.
- Web Trip attempt 9: stronger rename assertion failed as expected; required headers were then corrected.
- Web full attempt 10: **32/32 passed**, no skips or automatic retries, including successful rename persistence. [JSON result](../generated/maestro-pilot-20260904/web-10-results.json).
- After the last test-only rename change, `pnpm typecheck:e2e`, focused Biome check, and `git diff --check` passed. No application source changed after final `pnpm verify`.

No physical iPhone acceptance, Android run, merge-to-main, CI run, deployment, or push was performed. Native compilation, simulator journey acceptance, lower-level tests, and physical-device acceptance are separate gates. The repository's merge/CI definition of done is not met by local checks alone. The native API/proxy remain running against the isolated pilot table; developer data was not reset. The final race request hold was released by cleanup.

## F. Changed files and review

`changed-files.json` is the complete 47-file final pilot source/test manifest; the 44-file build-time version is retained as `build-5-changed-files.json`. This report is an additional changed documentation file; `tested-working-tree.patch` includes new files as well as tracked changes. Production changes are limited to calendar range/progress/boundary state and rendering, calendar status ownership, native swipe behavior, the snooze accessible row label, and restored web Activity-detail freshness. Native persistence continues through the existing SQLite projection/transaction path; web retains its existing transport/cache ownership, with restored Activity detail freshness now revalidated. No schema migration or dependency was added.

Two independent reviews were performed against the originating contracts and coding standards. They caught and prompted corrections for: disjoint-window pagination, hidden unknown boundaries, synthetic requests beyond terminal coverage, untested boundary pending/error/retry state, an unscoped tomorrow fixture assertion, and weak race destination assertions. Their final source-diff reviews, including the ticker fixture, web cache, and rename assertion corrections, reported no outstanding actionable findings. They explicitly did not certify unrun gates or the deferred empty-date decision.

Changes remain local and uncommitted while completion limits remain. The four other-task documentation files listed in A are not part of this pilot's patch.

## G. Workflow observations

Observed:

1. One material product question was asked about the explicit empty-date contract conflict; it remains unanswered. Routine selectors, fixtures, compiler checks, and implementation choices proceeded without repeated permission questions.
2. Build-owner coordination prevented assuming somebody else's build provenance. The actual owner had no completed build to certify.
3. Sparse distance probes all passed; adding density reproduced the reported navigation problem. Assuming “six months is the threshold” would have misdiagnosed it.
4. The first bounded-fetch correction introduced a pagination regression. Independent review caught it before the final build.
5. Several failures were stale journey expectations rather than application behavior: Plan outcome semantics, native picker completion, List choice, final attachment deletion, and offscreen occurrence assertions.
6. Placing pilot artifacts beneath Playwright's default output directory destroyed earlier evidence. Subsequent runs use a separate root. This is a concrete retention failure, not merely a proposed risk.
7. Working-directory mistakes caused one interrupted build and several failed read/diagnostic commands. Fixture mistakes caused four non-diagnostic web-hook red attempts before the real failing regression was captured. All retained attempts are distinguished above.
8. Web's missing browser runtime should have been found before the full suite. The source-List failure passed on one rerun, then reproduced twice more. Inspecting the restored cache and request absence exposed its cause; repeated green execution alone would have hidden it.
9. Native waiting overlaps an existing API deadline in the controlled race. No application timeout or canonical requirement was relaxed to hide it.
10. A 32-pass web result still contained an ignored rename 400. Adding response and saved-title assertions exposed that false-positive path before correcting the request.
11. No user intervention after the pilot request is recorded. Some early activity predated this report; token usage is unavailable. The earliest retained baseline timestamp is 18:18:22 America/New_York on September 4. Final evidence capture: `2026-09-04T20:01:22-04:00`. The span from the earliest retained 18:18:22 baseline to this capture is approximately 103 minutes. This is an observed artifact span, not uninterrupted execution time.

## H. Proposed workflow improvements — not applied

- Allocate one durable artifact root per investigation outside every runner's cleanup directory; verify a retained baseline manifest before launching a second runner. Supported by the actual Playwright deletion.
- Record source patch/hash, profile, bundle hash, runtime, fixture table and build owner before each native acceptance run. Supported by the unknown inherited build provenance and interrupted scratch synchronization.
- Preflight browser binaries, profile existence, object storage and proxy controls before expensive catalogues. Supported by the missing Chromium and `/v1/me` failures.
- Start with a representative density/ordering probe, not only a distance matrix. Supported by sparse one-year success and dense one-year failure.
- Require a pagination/coverage review when introducing bounded random-access navigation. Supported by the first correction's skipped-middle regression.
- Treat native accessible names as the user-facing selector contract, and scope repeated occurrences to fixture/date ownership. Supported by the visually present but inaccessible snooze annotation and offscreen tomorrow assertions.
- Separate deterministic response-order tests from native automation timing capabilities; qualify any pass-on-rerun and retain controlled request traces. Supported by the held-race blocker and the web Trip pass followed by repeated failures and a captured stale cache.
- Audit unasserted mutation responses when evaluating passing E2E coverage. Supported by the rename request that failed even in the first 32-pass web run.
- Use a small checked source-sync command with an explicit repository root and source manifest. Supported by the scratch-directory Git error.

No AGENTS.md, context-map, skill, workflow convention, or agent-playbook instruction was changed to apply these proposals.
