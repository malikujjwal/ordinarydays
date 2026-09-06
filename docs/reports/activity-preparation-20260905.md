# Activity Preparation: deletion, stale detail and mock fidelity — 2026-09-05

Status: reported stale-data and default-size layout corrections verified. Broader small-screen acceptance remains failing (12/23 native catalogue). Verification was recorded before the requested commit and push. No deployment or merge.

## Reported symptoms and observations

1. `P3 native Plans done 1788644656723_36107` is `act_01M1SRF1K6W04VAFMYDDSFP8SJ`. The existing simulator held it as canonical/scheduled; the local API returned 404. It was a Maestro-created fixture deleted by cleanup. An installed cached detail was not revalidated on entry, so it still offered actions against a missing parent. This is a stale-native-detail application defect exposed by test cleanup, not a prohibition against preparing completed Plans.
2. Chicken tacos (`act_01J8SEED0000000000000000A6`) retained `Dkwjedw` (`act_01M1SRYZCWEHVJMCWBQED6FY7Z`) in native `activity_children` and had local childCount=1. The API returned children=[] and childCount=0; the deleted child returned 404. A deterministic SQLite regression reproduced the local delete omitting the parent collection and count.
3. The progress formatter already returned `0 of 1 done`. Native bounds placed the counter at x=363..432 inside a section x=16..359 on a 375pt iPhone SE, exposing only the initial 0. The browser count check passed on the old UI: browser layout was not evidence of native correctness.
4. Empty Add controls used neutral filled pills without Plus icons, unlike the approved mock. Populated actions used a literal plus character and Prep rows lacked its divider. These were missed visual differences in the previous delivery.

## Contract and correction

- plans-and-lists §2.1/§3: explicit Prep creation, immediate parent membership/count, first-three/show-all and default incomplete rows. Native deletion now removes the parent projection and count transactionally with its outbox intent. Parent installs filter pending/tombstoned deletes and preserve protected child statuses.
- interaction-contract optimistic/failure rules: progress follows the displayed checkbox projection. Rejected deletion fetches the authoritative ordered parent collection, restores it with the child, and retains recovery when the parent cannot be read or installed. No child-derived guess at parent ordering is used.
- Native cached Activity entry reads local state first and revalidates through the existing sync owner. Authoritative deletion clears cached detail even when the subscription publishes during the request. Temporary network failure retries; unresolved local creation remains deferred. Additional entry revalidation is limited to Activity targets; occurrence handling is not broadened by this fix.
- Approved Activity mock: empty Add controls use Plus, outlined md boundaries, textAction colors, wrapping and 44pt minimum targets. Populated Prep/List/Photo actions use the same Plus icon. Prep rows have a quiet divider; section headers constrain the full count inside their width. Existing downstream dialogs, ownership, capabilities and relationships are preserved.
- Product and design docs clarify these requirements; no workflow/skill instructions or unrelated product contracts were changed.

## Regression evidence and attempts

- Native-state red: local delete retained the child; cached installed detail never discovered 404. Subsequent stale-parent regression showed deletion could be reinstalled by an in-flight parent read.
- Native Prep baseline attempt 1 stopped before detail entry: Today positioned the target partly beneath the bottom navigation. Retained as an independent navigation/test-entry failure. The new scoped journey enters through the public Activity deep link.
- Native Prep baseline attempt 2 created the child and deleted it through overflow confirmation; the parent still showed it and never returned the empty Prep chip. The screenshot also reproduced the clipped count. New journey keeps deletion, absence and relaunch assertions.
- Browser red: both normal/enlarged Add-control outline checks failed; the original browser count-fit case passed. Native layout now has an executable bounds assertion, since accessibility text visibility alone passed while the label was clipped.
- Review regressions caught rejected-delete membership restoration, pending-parent deferral, cached-detail subscription races, pending child status versus stale parent response, and installed-detail network retries. All received focused tests. Test-authoring failures (wrong subscription stub signature, an inconsistent restored-status fixture, and a missing NetworkError constructor argument) were corrected and retained in logs.
- A transient implementation mistake removed two letters from icon-bearing action labels; visible-text assertions caught it and the final labels are corrected. Earlier role-only assertions would not have caught it.
- Build 11 passed the delete/relaunch journey and native counter bounds. Inspecting its screenshots then caught a collapsed Preparation heading and a centered Add action introduced by the layout correction. An extended native assertion failed on the zero-width heading; the browser assertion failed on the Plus icon at x=97.28 instead of the action’s x=16. Build 12 gives the heading actual flex space and explicitly left-aligns action contents. These were application layout defects, not acceptable passes.
- Two build-11 native attempts stopped at an iOS Open-in-app dialog before Today. Maestro Cancel/Open probes reported taps but did not establish app readiness. A direct Simulator UI Open action did reach Today, after which the unchanged journey passed. The dialog’s repeated appearance was observed; its root cause is not established. No application workaround or assertion weakening was introduced.

## Environment and identity

Baseline HEAD `11e2a3cf61c34b0ccbbf8dec733db272e0b6578e` (`codex/fix-ios-startup-maestro`); working tree was clean at start. Xcode 26.6, iOS 26.5. Isolated iPhone SE3 `A254CB61-7B64-4767-B349-4A6971F5771E`, 375×667pt. Release/local app `app.ordinarydays.ios.local`; bundled JS, API proxy13000/control18474, isolated API13001. Native scratch checkout `/private/tmp/ordinarydays-maestro-20260904`. Main user-inspected simulator data was read and backed up, not reset. Other project tasks were idle; no concurrent build/server owner was displaced.

App version 0.1.0 (1), Xcode build 17F113, SDK iphonesimulator26.5: [bundle identity](../generated/activity-preparation-20260905/build12-identity.json). Final source/build identity: [source hashes](../generated/activity-preparation-20260905/source-hashes.json), [build 12 hashes](../generated/activity-preparation-20260905/build12-hashes.json), [pinned Maestro definitions](../generated/activity-preparation-20260905/catalogue-flow-hashes.json). Raw evidence: `/private/tmp/od-prep-audit-20260905/`.

The final build was also installed without data reset on the user-inspected iPhone 16 Pro (`56221A02-22E0-4E57-9E1D-80C9652EB2B3`). Opening the actual Chicken tacos record removed its stale child and restored all three Add controls. Its SQLite childCount is now 0. Opening the actual deleted `P3 native Plans done…` fixture reports Activity not found and removes the stale local entity. [Before records](../generated/activity-preparation-20260905/reported-records.json), [after records](../generated/activity-preparation-20260905/reported-records-after.json).

## Verification results

| Command / check | Result |
| --- | --- |
| `pnpm verify`, attempt 1 | Failed at local proxy lifecycle test: sandbox listen EPERM; no application assertion diagnosis inferred |
| `pnpm verify`, attempts 2 and 3 | PASS: 6,001 tests (mobile 2,324; UI 682; shared 1,180; API 1,630; infra 185), lint, typechecks, coverage, dependencies and versions; attempt 3 is final source |
| `pnpm test:int` | PASS: 612 integration tests |
| `pnpm --filter @od/shared test:guards` | PASS: 4/4 |
| `pnpm gen:openapi:check` | PASS on attempt 2, no drift; attempt 1 blocked by tsx local IPC EPERM |
| Web outline red | 2 failed, 1 passed |
| `pnpm e2e:web`, first complete run | 38/38; before extended alignment assertion |
| Extended web alignment red | 1 failed, 37 passed; Add icon centered instead of left-aligned |
| `pnpm e2e:web`, final source | PASS: 38/38 in 58.1s |
| Native builds 8–12 | Compiled; final build 12 has 0 errors, 1 existing warning |
| Native baseline Prep attempts 1 / 2 | Entry failure / reproduced retained deleted child and clipped count |
| Build 11 Prep attempts 1 / 2 | Both blocked by Open-in-app dialog before Today |
| Build 11 Prep attempt 3 | Delete, absence and relaunch passed; screenshot review then found heading/alignment defects |
| Build 11 cached deleted Plan | PASS |
| Build 11 extended heading assertion | Failed as intended: zero-width heading |
| Build 12 focused Prep journey | PASS: heading/count geometry, create/delete, immediate absence and relaunch absence |
| Scoped native Photo and List journeys | PASS: all original capability assertions preserved; only Activity entry uses the public deep link. These do not close catalogue entry failures. |
| Native SE AX5 layout, light and dark | Heading/count bounds and List/Photo control visibility pass. First light probe stopped during fixture setup (invalid non-UUID idempotency key); corrected helper then passed. People-row clipping remains visually observed. |
| Original preserved-data simulator | Corrected actual Chicken tacos and deleted Plan verified; no data reset |
| Build 12 complete SE catalogue, one attempt | **12/23 passed, 11 failed**; both new cases passed. This is not a green catalogue. |

### Full catalogue failures and limits

[All 23 case results](../generated/activity-preparation-20260905/catalogue-results.json). Existing flow definitions were unchanged throughout this run. The two new cases passed independently and together in the catalogue; the catalogue pass is a clean-data repeat of the focused Prep journey.

| Failed existing case | Observed evidence / classification |
| --- | --- |
| Offline queue/relaunch | Third fixture is offscreen before any offline mutation. The second row is already y=655..699 on a 667pt screen. Test viewport/setup failure. |
| Dense-year calendar | Date/content/request assertions pass, then detail tap leaves the app on Lists. Tab-bar interception is supported by the screenshot; global entry remains unverified. |
| Attachment projection | Stops at Today-to-detail entry before Photo; no photo operation attempted. Scoped capability run recorded separately. |
| Snooze occurrence | Correct snoozed 7:27 PM exists at y=581..625, overlapping tabs at y=603..659; visibility assertion fails. Test viewport expectation. |
| Recurring create window | Maestro `hideKeyboard` fails before the distant-date checks. Automation dismissal failure; those gates are unrun. |
| Recurring Past | Prior-day incomplete row is visible, older completed fixture is outside the captured viewport. Missing scrolling is the leading test hypothesis; older occurrence acceptance remains open. |
| Recurring edit window | Maestro `hideKeyboard` fails before edit/navigation acceptance. |
| Original Prep parent | Today target y=578..622 overlaps bottom navigation; no detail entered. New direct-entry Prep journey verifies capability, not this entry path. |
| Completing today leaves tomorrow live | Detail-open step lands on Lists; later recurrence assertions never execute. |
| Source List reconciliation | Today target y=578..622 overlaps bottom navigation. Scoped capability run recorded separately. |
| Add and complete | Earlier is expanded, but target completion is outside the captured viewport. Visibility/setup is a hypothesis; the original journey remains failed. |

These failures are not silently retried into green, and the scoped checks do not replace them. No broader Today/Plans layout or keyboard workaround was included in this Activity Preparation correction. The earlier standard-screen catalogue and this SE run are different acceptance configurations. Brief read-only verification on the second simulator used the same API early in the catalogue; it was then stopped to prevent request-instrumentation interference. No failure here was a request-budget assertion, but the overlap is disclosed.

### Visual evidence

[User screenshot before](../generated/activity-preparation-20260905/user-before.png), [native counter before](../generated/activity-preparation-20260905/before-preparation.png), [full heading/count and action styling after](../generated/activity-preparation-20260905/after-preparation.png), [empty controls after deletion](../generated/activity-preparation-20260905/after-delete.png), [original Chicken tacos after](../generated/activity-preparation-20260905/chicken-tacos-after.png), [original deleted Plan after](../generated/activity-preparation-20260905/reported-deleted-plan-after.png).

[Largest-text Preparation](../generated/activity-preparation-20260905/preparation-ax5-light.png), [largest-text controls, light](../generated/activity-preparation-20260905/add-controls-ax5-light.png), [largest-text controls, dark](../generated/activity-preparation-20260905/add-controls-ax5-dark.png). These screenshots establish the named controls, not the entire screen’s accessibility acceptance.

### Coverage mapping

- `prep-delete-reconciliation.yaml`: create a distinctive prep task, verify full count and positive contained heading geometry, delete through the user confirmation, assert absence and restored empty Prep action, relaunch and reassert absence. Catches the reported deletion/count defect.
- `prep-deleted-plan.yaml`: open/cache a test-owned Plan, delete that exact fixture through the API, reopen, require the unavailable state and no editable detail. Catches the reported ghost Plan.
- SQLite tests: immediate parent membership/count, stale reads after deletion, protected pending completion, rejected-delete restoration, unavailable/guarded-parent deferral.
- Native detail-hook tests: cached 404, deletion subscription/request race, single entry revalidation and retry after a transient failure with both initially installed/missing detail.
- Component/browser tests: visible action wording, optimistic progress/rollback, normal/enlarged outlined Plus controls, heading visibility and populated action alignment.

A neighboring run was deliberately interrupted after cached-deleted-Plan passed to correct the screenshot findings; the following Prep neighbor was not completed. No interrupted result is counted as a pass.

## Review and limitations

Separate standards/specification review identified the failure-handling gaps above; focused regressions now cover them. The final bounded reviews found no remaining concrete standards or contract regressions in the changed code and inspected the final native screenshot. These were read-only reviews; reviewers did not rerun simulator checks. Previously reported Today AX5 and physical-device/VoiceOver gaps are not closed by Activity-specific checks. No universal app/Phase4 readiness claim is made. At AX5 the full Preparation heading/count and Add controls fit, but the adjacent existing People row visibly breaks/clips its label and subtitle; the heading itself wraps across lines. This is not full large-text acceptance. Physical-device camera, VoiceOver speech/focus, and the previously documented navigation/keyboard matrix remain unrun or open.

The earlier 21/21 catalogue did not test prep deletion, full native counter geometry, or cached detail after external deletion. Its pass was valid for those journeys and insufficient for these reported behaviors. Future coverage proposals: retain these distinct journeys and require native containment assertions for layout-sensitive labels. These observations do not modify workflow instructions. No token or elapsed-time total is claimed.

## Workflow observations and proposals (not applied)

- The user’s follow-up exposed real persistence and visual gaps missed by the prior catalogue. Passing names/count strings were insufficient: the full native counter was offscreen, and the initial counter correction collapsed its neighboring heading.
- Test-first review of failure recovery found additional races before delivery. Parent and child restoration need transactional evidence, including pending parent intent, not only a successful network response.
- Repeated builds were necessary after those review findings and screenshot corrections. Test-authoring mistakes and the Open-in-app dialog added work; their failures remain in the logs.
- The initial verification and OpenAPI attempts omitted the local socket/IPC access needed in this sandbox. Both then ran successfully with that access.
- Proposal: inspect final native screenshots as well as assertions, require positive bounds for adjacent labels together, and distinguish global navigation/viewport tests from focused capability acceptance. Do not replace a failing global journey with a deep-link test and call the original passed.
- Proposal: treat deleted test fixtures as a supported native-cache reconciliation scenario and retain the new isolated regression.
- No workflow/skill instructions changed, no permission questions were asked, and no elapsed-time/token total is available beyond command durations.

## Changed files and retained evidence

The correction spans the native Activity transaction/repository/sync owner and detail hook; Activity Add/section components; their focused tests; two new Maestro journeys/scripts; the web Activity capability spec; and narrow product/design clarifications. [Exact changed files](../generated/activity-preparation-20260905/task-files.json), [reviewable diff](../generated/activity-preparation-20260905/change.patch). No dependency, schema, API, recurrence-contract or workflow/skill changes.

Final command logs: [repository checks](../generated/activity-preparation-20260905/verify3.log), [web](../generated/activity-preparation-20260905/web-final2.log), [integration](../generated/activity-preparation-20260905/integration-final.log), [scope guards](../generated/activity-preparation-20260905/guards-final.log), [OpenAPI](../generated/activity-preparation-20260905/openapi-final2.log), [native compilation](../generated/activity-preparation-20260905/native-build12.log), [focused native regression](../generated/activity-preparation-20260905/header-native-green.log), [full SE catalogue](../generated/activity-preparation-20260905/catalogue-final.log), [scoped Photo](../generated/activity-preparation-20260905/scoped-attachment-native-projection.log), [scoped List](../generated/activity-preparation-20260905/scoped-source-list-reconciliation.log).

[Complete attempt index](../generated/activity-preparation-20260905/attempt-index.json) and [diagnostic archive](../generated/activity-preparation-20260905/diagnostics.tar.gz) retain failed attempts, command metadata, screenshots and native hierarchies. The private full-database baseline backup remains only in the raw temporary directory and is excluded from the archive. Artifacts under docs/generated are ignored local files; this report does not claim they have been committed or uploaded.
