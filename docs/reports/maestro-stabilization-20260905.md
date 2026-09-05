# Maestro stabilization — 5 September 2026

Status: final clean-build catalogue passed 20/20 twice, including a fresh seeded-table repeat. No failures remain in the executed final gates. Physical-device, remote CI and merge acceptance remain unrun.

## A. Environment and build identity

Repository base `1e3c40ad80155cf6120547cf945fe02c60a604d3`, branch `codex/fix-ios-startup-maestro`, plus the uncommitted changes below. Release/local iOS app `app.ordinarydays.ios.local`; iPhone 16 Pro simulator `56221A02-22E0-4E57-9E1D-80C9652EB2B3`, iOS 26.5, Xcode 26.6, macOS 26.3. Node 22.23.2, pnpm 9.15.9, Java 17, Maestro 2.10.0.

The isolated build checkout is `/private/tmp/ordinarydays-maestro-20260904`. All compared tracked mobile/package production sources match the working checkout; only Expo-generated package command scripts differ. Installed binary and bundle hashes matched the final clean build before the catalogue. [Build identity](../generated/maestro-stabilization-20260905/build-identity-final.json) and [source comparison](../generated/maestro-stabilization-20260905/source-comparison-final.json) identify the tested artifact. Temporary trace code existed only in the disposable build checkout and was removed before the final build.

Native test API/proxy/control use ports 13001/13000/18474. Each `pnpm e2e:native:stack` invocation owns a fresh DynamoDB Local table, seeded with 24 ordinary activities and the local profile. It rejects occupied ports and non-loopback database endpoints, does not inherit the development table, and shuts down its own process groups. The original user simulator, development services, and real `Repeated plan` were not reset or edited.

## B. Baseline and attempt evidence

The preceding investigation ended with 12/20 failures on both its final app and the retained old app under shared-account conditions; see [the prior report](repeated-plan-edit-fix-20260905.md). That comparison did not establish identical causes for all failures.

This investigation first moved the unchanged offline journey to isolated services. The first pilot failed because Maestro flow-local endpoint values overrode runner CLI values: the app read the isolated API while fixture scripts wrote to the development API. Removing those overrides made the unchanged pilot pass. The first isolated full catalogue passed 18/20, including all 12 previously failing journeys. Remaining failures were calendar selection race and the recurring-edit interaction.

After correcting those, a second clean full catalogue again passed 18/20, with different failures: dense-year same-date reselection and recurrence stabilization's simultaneous-visibility assumption. These are preserved, not retried into an unqualified pass. [Case-by-case attempts](../generated/maestro-stabilization-20260905/case-results.md) and matching XML/log/artifact directories retain screenshots, hierarchies and commands.

## C. Classification, cause, contract, correction

| Failure | Classification and confirmed evidence | Correction |
| --- | --- | --- |
| Shared-stack baseline failures | Harness isolation dependency. The offline pilot demonstrated mismatched fixture/app endpoints. All twelve previous failures passed in the first isolated catalogue. This does not prove every historical failure had precisely the same root cause. | One runner owns endpoint values; flow overrides removed. Fresh owned test table and separate services preserve user data. CI explicitly supplies its own matching endpoints. |
| Proxy will not stop with held request | Harness lifecycle bug. Actual child-process regression remained alive on SIGTERM; fixed version and actual stack shutdown exited with no owned children left. | Clear tracked timers and close held connections; launcher terminates only its process groups. |
| Recurring-edit cannot open details | Incorrect test interaction. Centering the title scrolled it behind the Today header. | Scroll and tap the title below Today and above the tab bar, preserving exact post-edit/relaunch assertions. |
| Selection race lands with earlier day visible | Application layout logic defect. Original full-run screenshot showed the earlier card below the calendar. Trace samples exposed stale expanded chrome in compact landing and offset-zero feedback reopening the header; two component regressions reproduced these mechanisms. | Associate chrome measurement with presentation; wait for compact geometry, and ignore transient top offsets during the existing programmatic landing window. Manual dragging still cancels the landing. |
| Dense-year reselection after backward scrolling | Application navigation ownership defect. Independently failed in the instrumented simulator: retained prefix grew to 11 rows; reselecting the same date shrank it, sent the correct target/462-point offset, then native scrolling reported zero. | Every explicit native date command gets a fresh list identity, including the same date. This separates the earlier maintained-position anchor from the new landing; ordinary prepend scrolling retains its anchor. |
| Offline-created task appears in later cases | Harness cleanup race. A uniquely titled `Native new daily` from the earlier flow appeared in the later failure screenshot. Reconnect returned before the outbox create reached server storage; immediate cleanup discovery missed it. | Condition-based exact-title persistence observation captures the durable Activity ID before deletion. A submitted-create flag also covers failure-path cleanup. Timeouts report incomplete cleanup explicitly. |
| Recurrence stabilization cannot see tomorrow | Incorrect test expectation. Today fills the screenshot with valid activities; tomorrow need not fit simultaneously. The leaked fixture increased density. | Scroll to and open the occurrence contained by Today's card. The journey still independently selects tomorrow and asserts that its exact occurrence remains incomplete. |

The calendar corrections implement [Plans §1.3.4](../01-product/plans-and-lists.md): exact card below the measured visible overlay, immediate distant jump, stable header inset, bounded 256 ms virtualized recovery, and normal manual scrolling. No canonical behavior, retry duration, date requirement, native SQLite/outbox ownership or web data ownership was changed. The architectural issue was competing ownership of native scroll position, not a requirement to fetch or render intervening months. A broad rewrite was unnecessary for these diagnosed defects.

The earlier recurring projection/save fix remains in the working tree and is documented separately in the prior report. It preserves sparse retained dates and bounded canonical reconciliation; this task did not replace it.

## D. Regression and coverage mapping

- Expanded-to-compact measurement regression: red before fix, green after; verifies no compact jump uses expanded geometry.
- Transient offset-zero regression: red before fix, green after; verifies programmatic landing does not reopen the header, while later/manual top navigation still can.
- Same-date native landing regression: red before fix, green after; verifies a previous native anchor cannot own a new explicit command. Original dense-year journey independently failed with trace, then passed with the correction and again in the clean-build catalogue.
- Proxy lifecycle regression: actual held request plus SIGTERM, red/green. Stack shutdown separately verified all owned child processes exited.
- Durable-create observation: delayed exact-title server response, red/green; unrelated title cannot satisfy it. Script regression records the returned cleanup ID. Failure-path cleanup regression went red before the submitted-create handling and green afterward.
- Existing calendar journeys retain next-month, six-month, one-year, past, year-boundary, empty-day, overlapping request, detail-return, and Today assertions with distinctive seeded content. Dense-year covers backward scrolling and reselection. Request instrumentation continues checking bounded windows; screenshots are not used as proof of bounded fetching.
- Recurring-create gains an observable reconnect persistence assertion after its offline/relaunch checks. Recurring-edit retains the UI-created Plan, distant time edit, exact content and relaunch assertions.

## E. Final commands and limits

| Gate | Result |
| --- | --- |
| Clean final native Release/local compilation | Passed; installed hashes match build |
| Final full Maestro catalogue, attempt 3 | 20/20 passed, 8m35s |
| Fresh-table final catalogue, attempt 4 | 20/20 passed, 8m38s; unchanged build |
| `pnpm verify` on final source | Passed: 5,980 tests plus lint, type, dependency, forbidden-pattern and version checks |
| `pnpm --filter @od/shared test:guards` | 4/4 passed |
| `pnpm test:int` | 612/612, 30 files |
| `pnpm gen:openapi:check` | Passed, no generated drift |
| Final `pnpm e2e:web` | 32/32, 52.7 seconds |
| Deliberate failed-journey cleanup probe | Expected assertion failure; cleanup completed; server lookup found no leftover owned offline task |

`pnpm verify` first failed because sandbox networking denied the lifecycle test's local listen operation (EPERM); the networking-enabled run passed. OpenAPI generation similarly needed local IPC permission; its second invocation passed with no drift. Later changes received final verification. The final full native attempt followed the fixes; it is not a relabeling of either earlier 18/20 result. The deliberate diagnostic failure is separate from the catalogue and is not hidden as a pass.

Commands used: `pnpm e2e:native:stack`; Release/local `expo run:ios` with `EXPO_PUBLIC_API_BASE_URL=http://127.0.0.1:13000`; focused `pnpm e2e:native --flow apps/mobile/e2e/<case>.yaml --device <id>`; complete `maestro test . --config <retained full-catalogue.yaml> --driver-host-port 22087 --device <id> -e API_BASE_URL=http://127.0.0.1:13000 -e PROXY_CONTROL_URL=http://127.0.0.1:18474 --format junit ...`. The diagnostic catalogue config continues after failures so every case is reported; it contains all twenty normal flows and no retries.

[Final verification log](../generated/maestro-stabilization-20260905/verify-final.log), [web log](../generated/maestro-stabilization-20260905/web-2.log), [integration log](../generated/maestro-stabilization-20260905/integration-1.log), [full catalogue 3](../generated/maestro-stabilization-20260905/isolated-full-3.xml), [fresh repeat 4](../generated/maestro-stabilization-20260905/isolated-full-4.xml), [failure cleanup probe](../generated/maestro-stabilization-20260905/failure-cleanup-probe.xml), [cleanup server check](../generated/maestro-stabilization-20260905/failure-cleanup-server-check.json).

Native compilation, simulator journeys and physical-device acceptance are separate gates. No physical-device, TestFlight, remote CI, deployment, commit or push is claimed. The CI workflow was updated for seeded profile and runner endpoint ownership but was not executed here. Existing remote attachment-service setup must be verified separately before treating that workflow as accepted.

## F. Changed files and review

Application: `PlansScreen.tsx` and its tests, plus the preserved previous recurring projection fix and tests. Harness: `e2e/native-stack.mjs`, `mobile-network-proxy.mjs`, `run-native.mjs`, root package script, native CI workflow, all catalogue endpoint declarations, proxy/runner/script/lifecycle tests. Journey corrections: recurring edit, recurring create, recurrence stabilization, and the new persistence assertion script/cleanup handling.

Standards review: no outstanding actionable findings. Spec review: found the failed-journey cleanup gap; corrected with a failing regression, then reviewer confirmed closure. Final simulator gates remain evidence requirements independent of review. Existing user-owned AGENTS.md, CONTEXT-MAP.md, playbook and workflow-guide changes were preserved; no agent/skill instructions were edited.

## G. Workflow observations

Observed: isolated test services exposed real navigation defects that broad shared-account failures obscured. A passing focused race sample did not establish stability; the next full catalogue found a different navigation problem. The same-date native trace supplied a reproducible failure; lower-level tests alone could not model the platform scroll adjustment. Full-suite execution exposed a cleanup race invisible in a standalone offline test. Review caught failure-path cleanup after successful-path cleanup was fixed.

Repeated work: one runner invocation used a flow name instead of a path and ran no tests; one build started in the root checkout, generated native scaffolding, then failed before installation. Its generated package changes/native directory were removed, and the build reran in the isolated checkout. One regression assertion tried to print a large React instance and the worker exited; the concise boolean identity assertion produced the intended red. Sandbox-only verification was rerun with local networking. All corresponding logs remain available.

No new user questions or interventions were required. Whole-session elapsed time and token usage are unavailable; test/build logs retain their actual durations. No totals are invented.

## H. Proposed workflow improvements — not applied as instructions

1. Make build identity plus isolated fixture identity part of every native acceptance record; endpoint override precedence and shared data caused misleading failures here.
2. Require a full-catalogue run after focused fixes and a clean repeat of pilots; passing focused samples missed dense-year reselection and cleanup leakage.
3. Treat explicit navigation and manual scroll preservation as separate ownership in future list designs; their interaction caused the reproduced same-date failure.
4. Test both successful and failed cleanup paths for offline journeys; reconnect availability does not establish durable persistence.
5. Keep native geometry evidence alongside public component regressions. A visible heading alone missed an activity below the viewport; content assertions caught it.

Evidence is preserved under `docs/generated/maestro-stabilization-20260905` (local ignored diagnostic artifacts) and the original `/private/tmp/od-maestro-stabilization-20260905`. No workflow/skill instruction changes were applied.


Final cleanup inspection covered eight visited dates plus Lists and found no fixture-title leftovers: [result](../generated/maestro-stabilization-20260905/full-4-cleanup-check.json). This is an observable fixture check, not a claim that every database row was audited. The final isolated stack remains available for simulator inspection at delivery (PID 94955, table `od-main-maestro-1788633146561-8efe0291`); the temporary trace collector was stopped. Development services remain untouched.

The [review summary](../generated/maestro-stabilization-20260905/review-summary.md), [exact changed-file hashes](../generated/maestro-stabilization-20260905/changed-files.json), retained `review.diff`, and untracked source snapshots allow another agent to inspect the final change. No commit or push was made.
