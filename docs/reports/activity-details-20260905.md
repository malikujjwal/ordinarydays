# Activity details implementation — 2026-09-05

Status: original implementation verification completed, with limited device acceptance. The [small-screen follow-up audit](activity-small-screen-20260905.md) supersedes any implication of full compact-screen or Dynamic Type compliance. No deployment, merge, commit, or push performed.

## Correction after user review

The original summary did not explicitly demonstrate Prep task, List, and Photo on the small simulator. Those actions were preserved and were included in the standard native catalogue, but that did not establish their small-screen acceptance. The follow-up audit tests them individually, fixes an existing owner-only Photo entry gap and enlarged Photo-button clipping, and records the still-open Today AX5 failure. Full contract compliance is **not** established by the earlier 21-flow pass.

## Scope and contract

Implemented the approved `/private/tmp/od-ui-pilot-20260904/activity-mock-v1/` reference after reading README/index and opening the interactive preview. The user's explicit approval supersedes the mock README's earlier approval status. Fixture data and simplified dialogs were not adopted as product behavior.

Notes now expose Add notes/Edit notes, a bordered inline field with persistent label, and explicit Save notes/Cancel. Drafts survive blur, keyboard dismissal, failed persistence and incoming data refreshes. Save shows progress and blocks duplicate submissions. Dirty Cancel and navigation offer Keep editing/Discard changes. Focus returns to the editor after Keep editing and to the notes action after closing. Pending activities retain read-only full-notes expansion.

Long titles wrap and still save on blur. Reminder/Repeat use existing action colors and disclosures. Existing action, schedule, recurrence, preparation, List, attachment, pending-state and Related plan behavior remains in place. Navigation guards include Back, route removal, preparation/List destinations, completion follow-up, duplicate/delete and recurrence conversion before their mutation/navigation.

The narrow approved exception is documented in `docs/01-product/activities.md` §6.1, the interaction contract's notes control entry, plans-and-lists Notes row, and design-system Activity notes exception. No workflow/skill instructions were changed. Native save success remains a durable SQLite/outbox commit; it does not require an online server acknowledgement.

## Environment and build identity

- Repository HEAD: `1e3c40ad80155cf6120547cf945fe02c60a604d3`, branch `codex/fix-ios-startup-maestro`, with pre-existing and task-owned uncommitted changes. HEAD alone does not identify the tested build.
- macOS 26.3; Xcode 26.6; Node 22.23.2; pnpm 9.15.9; Java 17; Maestro 2.10.0; iOS 26.5.
- Release/local profile; bundle ID `app.ordinarydays.ios.local`; bundled JS; API proxy `http://127.0.0.1:13000`.
- Isolated native build checkout: `/private/tmp/ordinarydays-maestro-20260904`.
- Standard simulator: iPhone 16 Pro, `56221A02-22E0-4E57-9E1D-80C9652EB2B3`.
- Small-screen simulator: iPhone SE (3rd generation), `A254CB61-7B64-4767-B349-4A6971F5771E`; largest accessibility text and dark appearance for stress verification.
- Test stack API/proxy/control: 13001/13000/18474. Fresh isolated DynamoDB table `od-main-maestro-1788638387079-637b19f9`. Original user simulator and original 3000/3001/8474 servers were left untouched.
- Build 5 binary SHA256: `d830864b4add4709966617c63d1134f98fe81db4e74e48e85d6e9b8092b6f952`.
- Build 5 JS bundle SHA256: `dd6b0ac24dc7566a665c49bb4c49cef2c3410f5d2a0f56697c9d1def9a51efb7`.
- Per-file source hashes and binary hashes are retained with the evidence. All five native builds compiled successfully. Latest build had no errors and one existing SDWebImage deployment-target warning.

## Regression evidence and corrections during verification

| Observation / failing evidence | Correction | Coverage |
| --- | --- | --- |
| Existing notes offered implicit blur-save and an insufficiently discoverable disclosure; focused editor tests failed before implementation | Dedicated draft controller and explicit labeled editor/actions | Hook tests, Activity detail tests, web light/dark journeys, native notes journey |
| First native notes run crashed: React Native has `window` but no browser `addEventListener` | Restrict beforeunload handler to web explicitly | Native route regression and subsequent simulator runs |
| Browser Keep editing did not restore focus after the sheet closed | Restore on actual shared Sheet dismissal, after its focus trap is removed | Light/dark browser focus assertions; shared Sheet tests |
| Multiline title height failed long→short→long editing | Inaccessible typography-matched layout mirror measures the bare field without truncation | Browser title shrink/grow assertions and Field tests |
| Review found completion follow-up/conversion could bypass dirty-draft guard | Guard navigation and conversion before mutation | Focused screen regressions, including no conversion write after Keep editing |
| Review found pending long notes lost read-only access | Restore Show notes/Show less without enabling pending mutation | Pending notes regression |
| Build 4 notes flow passed, but screenshot showed input hidden behind keyboard/footer | Measure actual footer and move only an occluded focused input above it | Two native helper tests; stronger Maestro assertion requires typed text and both actions visible |

Native SQLite/outbox and API persistence implementations were not changed by this UI task.

## Attempt history

All retained attempts are evidence; pass after a correction is not a first-attempt pass.

- Before-image capture: five attempts. Initial navigation had a truncated title selector, then system deep-link confirmation prompts, then an invalid absolute screenshot path. Fifth attempt captured the baseline using relative Maestro screenshot paths.
- Native notes attempts 1/2/3: crash (fixed web-only handler); redundant second hideKeyboard failed after keyboard was already dismissed (removed that redundant test action); pass. Screenshot review then found missing field visibility coverage.
- Build 4 full catalogue attempt 1 was stopped after one failure and three passes: a manually seeded screenshot fixture pushed an offline test row below its expected viewport. A fresh isolated stack removed that diagnostic-data contamination. Build 4 clean catalogue then passed 21/21 in 9m45s. This predates the final keyboard correction.
- Build 5 strengthened focused notes journey passed, including process relaunch and saved-value assertion. It passed again in the final complete catalogue: 21/21 in 9m26s, no retries within that run.
- Browser attempts 1–5 each passed 33/35: focus restoration, title resize, focus restoration, route-history fixture, and pointer entry respectively. The final entry uses the established accessible keyboard activation. Pointer hover/layout timing is a hypothesis, not a proven application defect. Focused attempt 6 passed 3/3. Subsequent complete runs passed 35/35 twice, including latest source.
- Verification attempt 1 failed on a missing native navigation test boundary mock and sandbox-denied loopback sockets. The mock was corrected and verification rerun with required local-process access. Attempts 2 and 3 passed; final attempt 4 pending below.
- One small-simulator install command omitted the configured shell environment and could not locate simctl; it succeeded after sourcing `~/.zprofile`. This was a tool invocation failure, not an app build failure.
- Small-screen AX5 full notes flow failed to reach Activity details through Today. The screenshot remained on Today; the exact row-hit cause was not isolated. Direct-entry attempt 1 hit the system Open confirmation. Attempt 2 accepted it but the notes action was scrolled above the usable viewport, so typing did not enter an editor. Attempt 3 centered the action and explicitly asserted editor entry; typed notes and both buttons were visible, and Save returned to Edit notes. These are retained as failed setup attempts, not silently retried passes.
- Final same-fixture native visual capture passed on its first attempt after the catalogue completed.
- Detailed test-first, typecheck, formatting and focused-check outputs are preserved in the evidence archive, including unsuccessful iterations.

## Final command results

| Command / gate | Result |
| --- | --- |
| `pnpm verify` (attempt 4, final source) | PASS: 5,990 tests (shared 1,180; API 1,630; infra 185; UI 682; mobile 2,313), lint, typechecks, coverage, dependency rules, forbidden patterns and package versions |
| `pnpm test:int` | PASS: 612 tests |
| `pnpm --filter @od/shared test:guards` | PASS: 4 tests |
| `pnpm e2e:web` (latest complete run) | PASS: 35/35, 1m; earlier attempts detailed above |
| Native Release compilation, build 5 | PASS; 0 errors, 1 existing warning |
| Build 5 focused native notes journey | PASS, including keyboard field/actions and process relaunch |
| iPhone SE / AX5 / dark focused editor | PASS after direct-entry and centering setup corrections; full Today-entry flow did not pass at this size |
| Build 5 complete native catalogue | PASS: 21/21 in 9m26s; final build, clean suite fixtures |
| `git diff --check` | PASS |

## Coverage mapping

- Empty→Add→save→reopen, existing→edit→blur/dismiss, unchanged Cancel, Keep editing, dirty discard, Back/return: native and web journeys plus component tests.
- Slow save, failed save, retained draft, retry, duplicate prevention: controlled persistence hook tests and web network interception assertions (not fixed sleeps).
- Navigation to child/List/follow-up and recurring conversion: focused Activity screen tests against existing behavior.
- Long title growth/shrink, small viewport and light/dark: browser journeys and screenshots. A 1,300-character editable note and long pending read-only notes are covered at the component layer; native long-note scrolling is not separately exercised.
- Keyboard field/action visibility and process relaunch persistence: native journey; measured occlusion/no-unnecessary-scroll unit tests.
- Accessible labels, focus restoration, live saving/error state and axe: component/browser assertions. These do not substitute for physical-device VoiceOver acceptance.

## Artifact locations

[Full retained diagnostics archive](../generated/activity-details-20260905/diagnostics.tar.gz), [final native log](../generated/activity-details-20260905/native-final-build5.log), [verification log](../generated/activity-details-20260905/verify4.log), [web log](../generated/activity-details-20260905/web-final2.log), [integration log](../generated/activity-details-20260905/integration.log), [environment](../generated/activity-details-20260905/environment.json), [build source hashes](../generated/activity-details-20260905/build5-source.json), [binary hashes](../generated/activity-details-20260905/build5-binary.json), and [task file inventory](../generated/activity-details-20260905/task-files.json).

Raw working evidence remains at `/private/tmp/od-activity-details-20260905/`. The archive includes every retained log/attempt and Maestro screenshots/results. `docs/generated/` is ignored by Git: these artifacts are local deliverables and must be attached explicitly if sharing outside this workspace. The Markdown report and implementation files are available in the working tree.

## Visual evidence

- [Before native details](../generated/activity-details-20260905/before-details.png) and [before notes](../generated/activity-details-20260905/before-notes.png).
- [Final native details, same fixture](../generated/activity-details-20260905/after-details.png) and [final meal notes editor](../generated/activity-details-20260905/after-editor.png).
- [Final native editor with keyboard](../generated/activity-details-20260905/after-notes-keyboard.png).
- [Small iPhone SE, dark, largest text, keyboard](../generated/activity-details-20260905/after-notes-small-dark-ax5.png).
- [Web light editor](../generated/activity-details-20260905/notes-editor-light.png) and [web dark editor](../generated/activity-details-20260905/notes-editor-dark.png).
- [Occlusion found during visual review](../generated/activity-details-20260905/keyboard-occlusion-before-fix.png): this passed the old button-only assertion and is retained as failed visual evidence.

The native before image uses the same long-title meal fixture as the final detail capture. Its pre-task installed build source identity was not independently established; it is visual baseline evidence, not a commit-to-commit benchmark.

## Changed files and review

Task file inventory: `docs/generated/activity-details-20260905/task-files.json`. This excludes unrelated pre-existing recurrence, calendar, Maestro infrastructure and agent-document changes. Shared files preserve those existing edits.

Production changes are the Activity screen/route, draft hook, notes components, RepeatSheet close callback, and shared Field/Button/Touchable/Sheet/ScreenShell/focused-scroll capabilities. Added direct navigation dependency uses the version already present in the lockfile. Tests cover hooks, screen, route, shared scrolling, native journey and browser journeys. Four product/design contract files document only the approved notes exception.

Two independent read-only reviews checked originating specification and coding standards. Their actionable findings were corrected; final rechecks reported no remaining actionable findings. Runtime gates are reported separately from review.

## Verification limitations

Physical iPhone, VoiceOver spoken output, hardware keyboard, Android and Safari acceptance have not been run. The complete Today-entry journey at AX5 remains unverified; the focused Activity editor succeeded after direct entry. Combined AX5 and failed-save native layout has not been exercised. Native slow/failing SQLite write injection was not exercised through Maestro; controlled lower-layer and browser failure tests cover draft retention and retry. Native offline/outbox and relaunch behavior is covered by the existing catalogue. Browser OS-level unload confirmation and native interactive swipe cancellation require manual acceptance beyond the route guard tests. No claim is made that compilation alone establishes these gates.

## Workflow observations and proposed improvements (not applied)

Observed: visual inspection found a keyboard occlusion missed by passing assertions; the suite shared fixture state with manual screenshot capture; web and native have different browser-global/modal-dismissal behavior; an unconfigured shell could not resolve Xcode tools. No additional user intervention or product clarification was required for this approved scope.

Proposals: retain screenshots alongside state assertions for keyboard-heavy screens; isolate manual visual fixtures from suite tables; keep native/web boundary tests for shared focus and modal changes; record source/bundle hashes with each native acceptance run. These proposals were not applied to workflow/skill instructions. Token usage is unavailable; retained logs provide command start/duration evidence.
