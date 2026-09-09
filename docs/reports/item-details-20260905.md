# Item details — mock implementation and evidence

Implemented the Item details reference while preserving automatic saving and the existing unguarded close behavior. The user explicitly answered **“Preserve current close behavior”**; the mock’s Keep editing / Discard dialog was not implemented. Changes are uncommitted. Nothing was merged, deployed or pushed.

## Scope and contract decisions

The README, HTML and interactive preview at `/private/tmp/od-item-details-v1/` / `http://127.0.0.1:8112/` were inspected before implementation. Fixtures, simulated persistence, placeholder dialogs and permanently expanded ingredient inputs were not copied.

- Persistent feedback distinguishes waiting, saving, acknowledged and failed writes. Native says **Saved on this device** only after the existing SQLite projection/outbox transaction resolves; web says **All changes saved** after the API resolves. This is not a claim that a native offline write has reached the server.
- A failed edit remains in the editor with Retry. New edits during a write, stale incoming projections, return-to-original edits, and close/reopen ordering are handled explicitly. Same-field writes serialize; different fields retain independent ownership.
- Close still flushes pending valid edits and dismisses. No discard behavior was introduced. Failed writes retain the existing toast recovery path after dismissal; an expired/replaced recovery toast releases abandoned failed reservations. This is not durable storage of unacknowledged failed drafts across process death.
- State choices use configured labels, selected semantics, wrapping and 44pt minimum targets. At large native text sizes, a scalable preferred width produces fewer columns and can shrink to fit the sheet.
- Place is one section with Name and Address. Empty optional Place clears it; an address without a name remains invalid instead of falsely reporting success. Numeric progress uses canonical validators.
- Header feedback remains outside the body scroller. At native font scale 2 and above, the header uses existing smaller typography/spacing tokens while retaining full text scaling and an unchanged Close target.
- Collapsed Sub-items, inline editing, reorder, removal, configured vocabulary/limits, Maps, provenance, Plan links, permissions, deletion/undo and feature gating retain their existing routes and models. Provenance navigation now uses the same flush-and-close path.

Narrow documentation updates: product `plans-and-lists.md` §5.6, the Item details paragraph in `interaction-contract.md`, and Sheet/Item details guidance in `design-system.md`. No workflow or skill instructions changed. Existing direct Sub-item removal is preserved; older wording describing a More menu remains a pre-existing contract/UI mismatch, not evidence that every unrelated product contract was exhaustively certified.

## Environment and exact identity

- Baseline: `a98caf8754be919147f37d56d4aeb0f43ab090cd`, branch `codex/fix-ios-startup-maestro`. Working tree was clean at intake. Existing mock/build tasks were checked before shared resource use.
- macOS 26.3, Xcode 26.6 (17F113), iOS 26.5; Node 22.23.2, pnpm 9.15.9, Maestro 2.10, Java 17.
- Dedicated simulator: **OD Notes Small Screen**, iPhone SE 3, 375×667pt, `A254CB61-7B64-4767-B349-4A6971F5771E`. Only this resettable device was cleared. Other simulators and ordinary user stack/data were preserved.
- Native app: `app.ordinarydays.ios.local`, Release, local profile, 0.1.0 (1). Copied source checkout: `/private/tmp/ordinarydays-maestro-20260904`. Native proxy/API/control: 13000/13001/18474; existing isolated table reused. Web tests use a separate real local API and task-owned fixtures.
- Exact final source hashes, patch and native bundle identity: [build identity](../generated/item-details-20260905/build-identity.json). Six native compilations succeeded; build 6 contains the final reviewed presentation. Final bundle SHA-256: `882f381dbe84a2c9001c6511bbd2ca288a987cc8495d140b23cd0694837d2535`.

## Before and after

Same baseline fixture and normal-text iPhone SE:

| Before | After |
| --- | --- |
| ![Before](../generated/item-details-20260905/screenshots/native-before.png) | ![After](../generated/item-details-20260905/screenshots/native-after.png) |

[Lower controls, fixed feedback](../generated/item-details-20260905/screenshots/native-after-secondary.png) · [Normal keyboard](../generated/item-details-20260905/screenshots/native-keyboard.png) · [Dark / maximum Dynamic Type keyboard](../generated/item-details-20260905/screenshots/native-ax5-keyboard.png). Populated/empty web feature screenshots are retained with the journeys below.

## Diagnosis and regression evidence

| Finding | Cause / correction | Evidence |
| --- | --- | --- |
| No truthful save lifecycle; an edit returning to a previous value could be lost during an earlier write | Simple debounce/draft comparisons could not represent acknowledged, in-flight and latest desired values separately. Added a small per-field autosave controller over existing persistence actions. | `red-components.log`: 21 passed, 2 failed before correction; final focused tests pass. |
| Older closed editor or old Retry could overwrite a newer editor | Draft ownership ended at the component while writes remained alive. Added ephemeral per-item/field write-turn reservations; newer intent supersedes old queued/failed work, without caching domain data or replacing native outbox ownership. | `red-cross-session.log` reproduces ordering failure; deferred controller/component tests cover older success, older failure, stale refresh and reopened projection. |
| Failure ownership could be lost on Close or when a second failure replaced the first toast | Inline error state and toast recovery had different lifetimes. Transfer recovery ownership and release only abandoned failed reservations. | Focused action/controller tests include failure before/after dismissal and two failed fields. |
| Invalid Place/progress or superseded invalid drafts could report saved | Validation and deduplication operated against stale acknowledged input. Preserve invalid drafts and use canonical validators before queueing. | Component tests cover required title, address without name, numeric limits and retry after corrections. |
| AX5 heading consumed too much of the small-screen sheet; state choices became tall narrow columns | Fixed chrome and narrow columns did not adapt adequately to scaled text. Use smaller existing header tokens and flexible preferred state widths, with full scaling preserved. | Before/after AX5 screenshots, keyboard-open measured field intersection and final native journey. |
| Baseline mobile typecheck failed resolving `@od/ui/theme` | Previous commit imported a non-exported package subpath in ListItemRow. Changed only the type import to the public `@od/ui` entry point. | Baseline confirmed with `git show`; final typecheck passes. |

The tests exercise observable persistence and recovery, not only screenshots. Native reconnect waits on the exact server-side note through test-proxy instrumentation. No arbitrary sleeps, assertion skips or snapshot-baseline updates were introduced.

## Coverage mapping

- `useItemAutosave.test.tsx`: independently pending fields, delayed acknowledgement, latest edit, return to prior value, lagging refresh, dismissal/unmount, cross-editor ordering, failed old Retry and abandoned reservations.
- `ItemSheet.test.tsx` / `useListItemActions.test.tsx`: feedback, failed drafts/retry, validation, Close flush/recovery, actual adapter acknowledgement and existing feature/action behavior.
- `Sheet.test.tsx`: fixed accessory remains outside the body and the existing dismissal/keyboard contract remains intact.
- `item-details-autosave.spec.ts`: real API acknowledgement, deliberately held/rejected first write, later draft retention, one retry request, exact persisted server value and Close/Escape/scrim. Six configured examples × light/dark/200% CSS text at 320×667 cover empty/populated features, wrapping, state selection, Place clear/edit, collapsed Sub-items, scrolling, return and axe checks.
- `item-details-autosave.yaml`: native local acknowledgement offline, keyboard-visible editor, relaunch preservation, reconnect and exact upstream note. Uses task-owned seeded data and cleanup.
- Existing `item-sheet.spec.ts`, `plan-this-item.spec.ts`, `list-row-spacing.spec.ts`: adjacent delete/undo, feature editing, explicit Plan choices, Plan links, checkbox independence, filters and Maps paths.

## Commands, attempts and gates

All logs and raw screenshots/hierarchies are preserved in [the artifact directory](../generated/item-details-20260905/); original work artifacts are `/private/tmp/od-item-details-20260905/`. Failures are not presented as first-attempt passes.

| Check | Results |
| --- | --- |
| Focused development iterations | Red, green and review regression logs retained individually. Final full Lists run: **531 tests / 44 files passed** (`lists-final.log`). Final presentation subset: **57 passed**, shared Sheet **22 passed**. |
| `pnpm verify` attempts 1–3 | Formatting and test-TypeScript issues corrected; logs retained. |
| `pnpm verify` attempt 4 | Local socket test blocked by sandbox `EPERM`; unaffected tests passed. Rerun with local socket permission. |
| `pnpm verify` attempt 5 | Passed 6,029 tests before the final two retry-ownership regressions were added. |
| `pnpm verify` final / presentation-final | **Passed 6,031 tests** (UI 683, shared 1,180, API 1,630, infra 185, mobile 2,353), plus lint, typechecks, coverage, dependency boundaries, forbidden patterns and version checks. Final small state-width correction was followed by focused tests, lint and typecheck. Existing 5 lint warnings / 2 infos remain. |
| Web attempt 1 | **9 passed / 18 failed**: new test selectors were ambiguous and a header assertion measured during sheet entrance. Corrected selectors and checked fixed ancestry/viewport visibility. |
| Web attempt 2 | **46/46 passed**: new 21 plus neighboring Item/Plan/row cases. |
| Web final | **27/27 passed** after header/status changes. Final2: **27/27 passed** after the last state wrapping change. |
| Full visual catalogue | **7 passed / 46 failed**: 45 screenshot differences and one new ambiguous Place Name selector. Corrected the selector; targeted rerun **2 behavior passes / 1 screenshot difference**. Baselines not changed. |
| Native attempts 1–3 | 1: local save/keyboard/relaunch passed but immediate server read raced outbox replay; replaced with exact condition-based observation. 2: environment setup failed because restarting proxy caused its supervisor to stop the API; restored the existing API/table. 3: **passed** normal-text offline/relaunch/reconnect. |
| AX5 attempts 1–4 | 1: exposed oversized header/offscreen Note. 2: test overscrolled a field taller than its viewport. 3: Maestro rejected decimal percentage coordinates. 4: exact value check caught a mid-text cursor leaving an old suffix after Backspace, despite a successful native save. Corrected measured intersection, integer coordinates and explicit full-text selection. |
| AX5 attempt 5 | Test menu assumption failed: at maximum text size iOS paginates the editing menu, showing Select followed by Forward; Select All was on the next page. Added the observed conditional menu navigation. |
| AX5 attempt 6 | **Passed on final build**: exact field value, measured keyboard-open intersection, local ACK, relaunch, exact upstream note after reconnect. |
| Native final | **Passed on final build**, normal text/light, mixed feature fixture, clean data. Full value replacement and same offline/relaunch/reconnect assertions. |
| Native secondary | **Passed**: scrolled to lower controls; Add ingredient, collapsed Edit Lemon, Plan this item and Delete item reachable while feedback remained visible. Screenshot preserved. |

### Visual gate limitation

The visual catalogue is **not green**. One untouched overview actual screenshot is byte-identical to a previously recorded clean-baseline failure (`b875a83`), SHA-256 `ca123ed8468a64450a2c7e8600d8d9500ddbbd879cad3972566ea9ea7ef49506`. This supports a pre-existing mismatch for that case; it does not prove all current differences are pre-existing. Item details intentionally changes snapshots. Font/rendering environment or stale baselines are hypotheses, not established causes. Baseline approval remains separate from this implementation.

## Review and remaining acceptance gaps

Two isolated reviews ran against the user requirements and repository standards. Findings about stale retry ownership, invalid drafts, cross-editor ordering, compact control overflow and simulator coordinates were corrected and re-reviewed. Both targeted final reviews reported no remaining concrete finding; this is not a substitute for the failed visual gate or physical-device acceptance.

Native compilation, simulator journeys, browser checks and physical-device acceptance are separate gates. Physical iPhone use, VoiceOver spoken announcements/rotor navigation, hardware keyboard focus, native swipe dismissal while a write fails, native SQLite failure/retry at maximum text size, and full unrelated Maestro catalogue were not run for this task. Shared Sheet tests and web Close/Escape/scrim checks do not certify those native interactions. The native local storage/outbox path was exercised; the separate full API integration suite was not run because no API/domain/native-storage implementation changed.

## Changed files

- Item UI/model: `ItemSheet.tsx`, `model/itemSheet.ts`, public Theme import in `ListItemRow.tsx`.
- Autosave/recovery: new `useItemAutosave.ts`, `itemWriteTurn.ts`, modified `useListItemActions.ts` and their tests.
- Shared Sheet: optional fixed accessory/compact header and focused regression.
- Native/web E2E: new autosave flow, measured scrolling and server verification scripts, exact-note proxy observer, new web matrix; existing visual selectors made exact for Name/Address.
- Three narrow product/interaction/design documents and this evidence report.

## Workflow observations

The only product question was the explicitly pending close decision; the user's answer was honored. Review found real asynchronous ownership defects beyond cosmetic changes, which required focused regressions. Native verification also exposed actual AX5 layout issues and several test-harness mistakes; every attempt is retained. Restarting a supervised proxy unnecessarily interrupted its API, and successive full exports/builds added repeated work. A future improvement would be to document resource lifecycle ownership and reuse the already-observed iOS driver frame schema before adding test helpers. These are proposals only; no workflow instructions were changed. Full-session elapsed time and token usage were not reliably available.
