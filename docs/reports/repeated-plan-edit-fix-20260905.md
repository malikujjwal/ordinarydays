# Repeated Plan edit fix — 2026-09-05

## Root cause and correction

Confirmed application defect: editing a recurring Plan rebuilt its local occurrence projection using only `agenda_coverage` (Today/reminder coverage), then deleted all other local rows for that Activity. Plans retained broader calendar coverage, so a distant date could be considered loaded while its occurrence had disappeared. The original user Plan was saved on the server; the missing calendar row did not establish a failed save.

The correction preserves sparse retained dates during local mutation. Canonical recurrence reconciliation now includes retained Plans windows, subtracts already-covered intervals, and splits requests at the existing 62-day maximum. It does not fill or request unknown gaps between calendar destinations. A coverage change during reconciliation schedules another pass before retiring the receipt.

Authoritative responses replace both Agenda and Plans cached rows, including empty responses and occurrence overrides. Dated Plans excludes undated Tasks and Today-only overdue copies. Merged rows sort by effective time and Activity identity. A second simulator-confirmed defect reset the rendered Upcoming extent on initial refresh while retaining distant calendar rows and coverage. Initial refresh now preserves the retained extent while accepting the fresh Today boundary and pagination cursor. A SQLite regression also asserts the exact sparse coverage.

Native SQLite/outbox remains the owner; no server API or web ownership change was made.

Contracts: [Plans membership, ordering, and permanent Past](../01-product/plans-and-lists.md#13-the-plans-tab); [targeted recurrence reconciliation](../02-architecture/api-contract.md) (lines 247–255); API window bound (line 297). The 62-day request width and 60-day occurrence-move limit are not a prohibition on changing an occurrence's time more than 60 days from Today.

## Environment and identity

Base revision `1e3c40ad80155cf6120547cf945fe02c60a604d3`, branch `codex/fix-ios-startup-maestro`, plus the uncommitted fix described here. Release/local simulator build; iPhone 16 Pro, iOS 26.5, isolated device `56221A02-22E0-4E57-9E1D-80C9652EB2B3`. macOS 26.3, Xcode 26.6, Node 22.23.2, pnpm 9.15.9, Java 17, Maestro 2.10.0.

Build source and artifact hashes are preserved in `build-source-final.json` and `build-identity.json`. The scratch build checkout's tracked mobile/package production sources were compared with the root checkout: no differences. User simulator data and the original Repeated plan were not reset or edited.

## Regression evidence

- Four real-SQLite mutation regressions failed before correction: occurrence and future edits at 61 days and one year. They now assert the selected occurrence time and preservation of nearby rows.
- Bounded reconciliation instrumentation asserts exact requests, a maximum 62-day request, and no intervening gap fetch.
- Public Plans projection cases cover distant dates, Past, saved overrides, authoritative empty results, preserved neighbors, correct ordering, and coverage growth during synchronization.
- Two additional red/green cases keep canonical undated and overdue Today rows out of dated Plans while preserving Agenda rows.
- New `recurring-edit-window.yaml` creates a uniquely named daily Plan through the UI after loading a distant calendar window, verifies its occurrence one year ahead, changes the time, verifies it remains, and repeats the check after process relaunch. Setup and cleanup are per-fixture; no suite-order dependency is intended.

## Attempts and final gates

Final native catalogue: **8 passed, 12 failed** in one full attempt. The final focused native regression passed once standalone and once in the full catalogue, each from cleared simulator test state, including relaunch. All 12 failing catalogue journeys were then run once against the retained old app: **12 failed**. This establishes that these journeys also fail without the patch under current shared-account data; it does not establish identical root causes, and some fail at earlier assertions on the old app. The complete E2E catalogue is **not green**. The corrected app was restored afterward. Focused SQLite suites: 183 tests passed. Final `pnpm verify`: passed (5,971 tests across workspace packages, plus lint, type checks, coverage, dependency/forbidden/version checks). Web: 32 journeys passed. API integration: 612 tests passed across 30 files. The web and API runs preceded the final native-only refresh-window adjustment; their code paths were unchanged. Native compilation passed; physical-device acceptance remains unrun. The first new Maestro attempt failed before reaching the edit because the Today row was occluded by the tab bar. The flow was corrected to scroll the row into the center. The second old-build attempt reached the post-edit assertion and failed because the distant Plan disappeared. This is the native regression red; the setup failure is not classified as an application defect. The first corrected-build attempt passed the post-edit assertion but failed after relaunch because the list date range reset. That application defect received its own failing SQLite regression and correction; it is not reported as pass-on-retry.

Lower-level intermediate attempts are retained, including failures that motivated canonical cache replacement, coverage continuation, ordering, and Plans eligibility. An intermediate corrected native build was followed by the eligibility-corrected build; that build exposed the relaunch defect. The final build includes its correction. One initial build was aborted after a scratch-copy path error; an intermediate build is not the final tested artifact.

## Changed files and review

Production: `agendaRepository.ts`, `plansRepository.ts`, `syncEngine.ts`, `sync/reconciliation.ts`. Regression tests: `activityTransactions.test.ts`, `syncEngine.test.ts`, `plansRepository.test.ts`; Maestro setup and new recurring-edit journey. This report is the documentation change.

Independent specification and standards reviews found and closed issues with canonical cache visibility, synchronization continuation, and Plans eligibility. Final review reported no outstanding actionable findings. Existing user-owned edits to AGENTS.md, CONTEXT-MAP.md, agent-playbook.md, and docs/agents/workflow.md were preserved; no workflow instructions were changed by this fix.

## Observations and proposed improvements

Observed: local projection loss and broad retained coverage disagreed; server persistence was correct. A server-seeded-only test could mask the UI-created Plan failure. Public Plans reads exposed problems that checking Agenda SQL alone missed. Independent review caught two adjacent consumers. An occluded Today row required correcting a Maestro interaction before the product assertion could be reached.

Proposals only: include a UI-created recurring Plan in native recurrence regression coverage; assert both local and public calendar projections; record exact build/source hashes before simulator runs; make coverage-growth and authoritative-empty cases standard synchronization checks. Keep query-window bounds instrumented rather than inferring them from screenshots.

Limitation: local edit projection still reads retained rows, so this does not establish constant mutation cost or a new performance budget. No physical-device acceptance, TestFlight, deployment, commit, or push is claimed. Exact total token usage is unavailable.

## Retained evidence and remaining failures

Evidence root: [archived artifacts](../generated/repeated-edit-fix-20260905/full-results.md). Original scratch copy: `/private/tmp/od-repeated-edit-fix-20260905`.

- [Exact build identity and installed hashes](../generated/repeated-edit-fix-20260905/build-identity.json), [production source hashes](../generated/repeated-edit-fix-20260905/build-source-final.json), [final native compilation](../generated/repeated-edit-fix-20260905/build-relaunch-final.log).
- [Original local-mutation red](../generated/repeated-edit-fix-20260905/red.log), [183-test focused green](../generated/repeated-edit-fix-20260905/green-relaunch.log), [refresh-window red](../generated/repeated-edit-fix-20260905/relaunch-red.log), [Plans-eligibility red](../generated/repeated-edit-fix-20260905/eligibility-red.log).
- [Maestro setup failure](../generated/repeated-edit-fix-20260905/native-red.xml), [old-build occurrence-loss red](../generated/repeated-edit-fix-20260905/native-red-2.xml), [first corrected-build relaunch failure](../generated/repeated-edit-fix-20260905/native-green-1.xml), [final focused green](../generated/repeated-edit-fix-20260905/native-green-2.xml).
- [Complete final catalogue](../generated/repeated-edit-fix-20260905/native-full.xml), [old-build comparison](../generated/repeated-edit-fix-20260905/native-old-controls.xml), [case-by-case comparison table](../generated/repeated-edit-fix-20260905/full-results.md). Corresponding `*-artifacts` directories contain screenshots, hierarchies, commands, and simulator logs for every attempt.
- [Final repository verification](../generated/repeated-edit-fix-20260905/verify-final-relaunch.log), [web results](../generated/repeated-edit-fix-20260905/web-final.log), [integration results](../generated/repeated-edit-fix-20260905/integration-final.log).
- [Earlier diagnosis, including server persistence and the user's untouched Plan](../generated/repeated-edit-diagnosis-20260905/SIMULATOR-REPORT.md).

Observed visibility/isolation failures: offline replay, Prep parent, source List, add/complete, local Plans create, and calendar return-to-Today checks assume their fixture is immediately visible. Current account data includes timed and recurring user activities above these fixtures. The offline hierarchy places its first fixture at y=823 under the tab bar; subsequent fixtures are outside the rendered viewport. The run did not reset the shared account or delete user activities to satisfy those assumptions.

Still unresolved: dense-calendar re-selection position, snooze position, attachment-detail opening, and recurring-completion calendar visibility require further isolation of application navigation versus test interaction/timing. They fail on both builds, sometimes at different checks. No assertion was weakened, case skipped, or retry presented as an unqualified pass. The broader E2E cleanup objective remains unfinished; this report claims completion only for the diagnosed recurring-edit and associated relaunch defects.

The final diff passed `git diff --check`. No commit or push was made. No user intervention or approval was required during this fix. Review iterations and the scratch-copy mistake caused repeated verification/build work; the retained attempt logs make that cost observable. Whole-session elapsed time and token usage were not reliably available, so no totals are invented.

Additional proposal, not applied: give native E2E an isolated seeded account and make fixture visibility checks scroll to their accessible target before interaction. This is supported by the same journeys failing on the pre-fix build with current account contents. Preserve the real user account as a separate acceptance scenario rather than treating its viewport as a deterministic fixture.
