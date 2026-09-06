# Activity details: small-screen contract audit — 2026-09-05

Follow-up: the [Preparation audit](activity-preparation-20260905.md) records the later reported stale-child, deleted-Plan cache and mock-styling defects, their corrections, and the additional SE catalogue failures. The historical passes below did not cover those new regressions.

Status: focused small-screen, repository and web checks passed. Full standard native catalogue passed 21/21 on attempt 2. AX5 Today acceptance remains open. Small screens are supported by the canonical design; complete largest-text accessibility compliance is not established. No contract was relaxed to accept a failure. No commit, push, deployment or merge was performed.

## Correction to the earlier report

The initial Activity details report omitted explicit small-screen evidence for Prep task, List and Photo. They were implemented and passed in the standard simulator catalogue, but that did not justify a blanket compatibility statement. This audit separates standard compact-screen behavior, AX5 Activity entry checks, and remaining app-wide gaps.

## Contract and evidence matrix

| Capability | Canonical requirement | Evidence / current result |
| --- | --- | --- |
| Compact layout | design-system §8: 320–429px compact layout; interaction-contract §6.3: scalable text and AX5 acceptance | All three Add actions fit measured 320px browser bounds at 13px and 52px action-label text. Native iPhone SE standard-text journeys below; its 375×667pt display is separate from the 320px browser test. Browser text stress does not simulate native Dynamic Type. |
| Prep task | plans-and-lists §2.1 empty chip/populated Add; §2.2 explicit parent linkage and return | Final-build iPhone SE journey creates a task and returns to the parent with it visible. |
| List | plans-and-lists §2.1 empty chip/populated Add; existing source relation and List behavior | Small-screen create/link, add item, return with count, settings, delete/return passed after a failed item-entry attempt; final-build repeat passed after removing the redundant autofocus tap, then passed again from clean data. |
| Photo | plans-and-lists §2.1 row 8: owner-only add/delete; P3-41/42 upload, viewer and native reconciliation | Upload/viewer passed on SE; original relaunch assertion failed because the section was offscreen. Explicit scrolling added; final repeat passed upload, viewer, relaunch, deletion and another relaunch, ending with all three Add actions visible. |
| Photo ownership | Same owner-only rule for empty and populated sections | Two participant cases failed before fix, pass after; two owner cases verify entry remains usable. |
| Enlarged Photo controls | interaction-contract §6.3: content-sized controls, no clipped text | Native AX5 screenshot showed clipped Camera/Photos/Done labels. Browser label-bound regression failed at 52px. Existing contentSized Button behavior now used; final AX5 screenshot shows full labels. |
| AX5 Activity entry/return | Add controls remain reachable with scalable text | Direct Activity entry → Prep compose/close → List sheet/close → Photo sheet/Done passes on final build. This is entry/return coverage, not full AX5 creation/upload acceptance. |
| Notes and existing activity behavior | activities §6.1 explicit notes exception; existing title autosave/actions unchanged | Prior notes simulator evidence plus current 135 Activity screen tests, including state transitions, recurrence, undo, pending/read-only, relationships and four Photo permission cases. Final full checks below. |
| App-wide AX5 navigation | interaction-contract §6.3 reflow; design-system Dynamic Type row | **OPEN:** Today header/count and rows clip at AX5; the seeded plan cannot reliably be reached through the catalogue's scroll-to-title path. Screenshot retained. Direct entry succeeding does not close this failure. |

## Actual fixes and test changes

1. ActivityDetailScreen uses the established `canManageAttachments` result and pending state to gate both empty Photo and populated Add photo callbacks. Participant viewing remains available; upload/delete ownership is unchanged at the API.
2. AttachmentPicker and its sheet use the existing content-sized Button option. Camera, Photos, Done, Retry and Remove can grow with text; upload and dismissal logic is unchanged.
3. Three Maestro journeys scroll to offscreen plan rows, entry controls and attachment sections. All original state assertions remain. List entry now explicitly asserts the typed draft before submission and retains a screenshot.
4. New browser coverage checks the three Add actions' actual bounds at 320px and checks Photos/Done label containment. It is a public layout regression, not a screenshot-only pass.
5. The responsive table now states a verification requirement instead of an unqualified historical acceptance claim. The design-system Activity exception explicitly names the three preserved Add actions, scrolling, populated-section Add behavior, owner-only Photo access and their return-path verification. The previous report's completion wording is corrected.

No AddToPlanRow/Chip layout rewrite was made: the suspected overflow of these three labels was not reproduced in measured browser tests or the native AX5 screenshot. Potential broader section/row reflow weaknesses remain review observations until independently reproduced; they are not marked fixed.

## Attempts, including failures

- Standard SE Prep attempt 1 failed because the test expected the plan above the fold. After adding ordinary scrolling, creation/parent projection passed. Final-build repeat passed.
- Standard SE List attempt 1 created/linked the list but failed to observe the later item. Attempt 2 added a pre-submit draft assertion and screenshot; the full create/item/settings/delete journey passed. This is a pass after a failed attempt; a persistence root cause was not established.
- Standard SE Photo attempt 1 uploaded and opened the image, then failed the relaunch section-visibility assertion. The screenshot showed the scrolled destination assumption. Added scroll-to-section before keeping the same assertions.
- AX5 Today-entry attempt failed to find the seeded plan and showed clipped layout. Direct-entry attempts on build 5 and final build 7 passed all three entry/return paths. Neither substitutes for the failed Today path.
- First 320px browser bounds checks passed without a layout change. Extending the regression to Photo label containment produced one failure at 52px and one pass at 13px before the sizing correction.
- Photo permission regression: two red tests before correction; both green afterward. Owner positive cases also pass. Entire focused Activity screen suite: 135/135.
- Full verification attempt 1: five failures in Activity/Today/Compose tests while Xcode compilation ran, including timeouts. Focused Activity tests had passed independently. Resource contention is a hypothesis; rerun passed all 5,994 tests and required checks after compilation completed, without increasing timeouts.
- Intermediate web suite passed 37/37 before the Photo sizing correction. Latest source run passed 37/37 in 49.7s, including the previously failing Photo label-containment case.
- Final-build List repeat failed at the new pre-submit draft assertion: the item text had not entered the field. This narrows the symptom to input/focus rather than a lost persisted item. A single-variable follow-up removed the redundant tap on the already-autofocused field; the entire journey passed. A clean repeat is recorded below. This supports a focus/automation race; it is not proof that a persistence bug was fixed.

- Final small-screen notes run reached the correct typed draft, but Maestro hideKeyboard failed while the keyboard remained visible. The flow now uses the user-visible Notes heading as an outside tap, preserving the unsaved-draft assertions; this changes the dismissal mechanism rather than removing the requirement.

- Notes outside tap/Keep editing passed, then a generic scroll-to-Back failed with the keyboard/footer occupying much of the SE viewport. A one-gesture probe anchored to the visible Notes heading brought Back into view immediately. The permanent flow now anchors that gesture to content before retaining the Back/navigation assertions; no application navigation change was made.

- Full standard catalogue attempt 1 finished 18/21. Photo failed before detail entry: the saved target button bounds were y=131–175, while the agenda begins at y=164, so its center tap landed above the scrollable content. An attempted parent-child selector then caused Prep and List entry failures: inspection proved the native row wrapper is not an ancestor of the pressable body in this hierarchy. The final candidate uses button ID plus unique activity label and scrolls only when it is offscreen. No production behavior was changed for these test failures. The corrected-selector Prep, List and Photo journeys then each passed independently on the standard simulator before catalogue attempt 2.

- Full standard catalogue attempt 2 passed 21/21 in 10m 49s on build 7. All flow definitions remained unchanged during the run. This pass follows the documented 18/21 attempt and selector corrections; it does not close the separate AX5 Today failure.

## Environment and reproducibility

Same repository HEAD/branch and isolated stack as the [original report](activity-details-20260905.md); uncommitted working-tree source must be identified by hashes, not HEAD alone. Build 7 is Release/local, bundled JS, `app.ordinarydays.ios.local`, API proxy 13000. Xcode 26.6, iOS 26.5, iPhone SE 3rd generation (375×667pt; `A254CB61-7B64-4767-B349-4A6971F5771E`) and iPhone 16 Pro (`56221A02-22E0-4E57-9E1D-80C9652EB2B3`). Other task/server/simulator ownership was checked; original user services/simulator remained untouched.

[Source hashes](../generated/activity-small-screen-20260905/source-hashes.json), [build 7 hashes](../generated/activity-small-screen-20260905/build7-hashes.json), [changed files](../generated/activity-small-screen-20260905/task-files.json).

Complete retained attempts, screenshots and native hierarchies: [diagnostic archive](../generated/activity-small-screen-20260905/diagnostics.tar.gz). Final command logs: [repository verification](../generated/activity-small-screen-20260905/verify2.log), [web suite](../generated/activity-small-screen-20260905/web-final.log), [native catalogue attempt 1](../generated/activity-small-screen-20260905/catalogue-final.log), [native catalogue attempt 2](../generated/activity-small-screen-20260905/catalogue-final2.log), and [pinned Maestro definitions](../generated/activity-small-screen-20260905/catalogue2-flow-hashes.json).

## Visual evidence

- [All three Add actions on the small screen](../generated/activity-small-screen-20260905/add-actions-small.png).
- [All three Add actions at AX5](../generated/activity-small-screen-20260905/add-actions-ax5.png).
- [Photo labels before](../generated/activity-small-screen-20260905/photo-ax5-before.png) → [after](../generated/activity-small-screen-20260905/photo-ax5-after.png).
- [Unresolved Today AX5 layout/navigation evidence](../generated/activity-small-screen-20260905/today-ax5-open-gap.png).

## Final results

| Check | Result |
| --- | --- |
| `pnpm verify`, attempt 2 | PASS: 5,994 tests (mobile 2,317; UI 682; shared 1,180; API 1,630; infra 185), lint, typechecks, coverage, dependencies and versions |
| `pnpm e2e:web`, latest source | PASS: 37/37, including normal/enlarged Add and Photo controls |
| Native builds 6 and 7 | Compiled successfully; build 7 includes both corrections |
| ActivityDetailScreen focused suite | PASS: 135/135 |
| Native AX5 direct Activity entries/returns, build 7 | PASS; Photo labels visually inspected |
| Native SE Prep, build 7 | PASS |
| Native SE List, build 7 | PASS twice after removing redundant autofocus tap; failed earlier attempts retained |
| Native SE Photo, build 7 | PASS: upload/viewer/relaunch/delete/relaunch; all three entry chips visible |
| Native SE notes, build 7 | PASS: outside tap retains draft, guarded Back/return, saved notes survive relaunch |
| Native AX5 Today entry | FAILED; open acceptance gap |
| Full standard native catalogue, build 7, attempt 1 | 18/21 passed; three test-entry failures; corrected-selector focused checks passed for all three journeys |
| Full standard native catalogue, build 7, attempt 2 | PASS: 21/21 in 10m 49s; flow hashes pinned and unchanged during run |
| Maestro script/runner checks | PASS: 17/17 |
| `git diff --check` | PASS |

## Review and remaining acceptance

This is not Phase 4 readiness sign-off: the open AX5 Today layout/navigation acceptance failure remains a stabilization item.

Standards review: no concrete findings in the final ownership/button/test changes. Specification review: identified Photo ownership and larger-text concerns; ownership and observed Photo clipping corrected. General chip overflow was not reproduced and was not mislabeled as a fix.

Cannot confirm that **everything** meets the contract: the AX5 Today path remains open. Full AX5 Prep creation, List creation/item editing and Photo upload were not run, only entry and return. Physical iPhone camera capture and VoiceOver spoken/focus acceptance are unrun. Permissions were tested at the component seam; no live shared-user simulator session was exercised. Earlier native SQLite failure injection/browser unload and gesture gaps remain as documented in the original report. These are acceptance gaps, not amendments making them optional.

## Workflow observations

The user intervention exposed missing small-screen coverage in the original delivery. Visual review again found clipping that an open/close smoke test missed. I also introduced a wrong parent-child Maestro selector before checking the native hierarchy, causing two extra catalogue failures. Inspecting the retained hierarchy identified that mistake. Future verification should inspect actual native hierarchy before changing selectors, preserve before-submit focus assertions, and distinguish button visibility from text containment. These are observations/proposals; no workflow or skill instructions were modified. No elapsed-time or token total is claimed beyond individual command logs.
