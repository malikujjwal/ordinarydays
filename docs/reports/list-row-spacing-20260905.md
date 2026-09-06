# List row spacing — mock v2 evidence

Implemented the approved compact grouping and address-to-details / separate Maps interaction.
At verification handoff the changes were uncommitted; no merge, deployment or push had been performed.

## Scope and contracts

The mock is `/private/tmp/od-list-rows-v1/v2/` (`README.md` and `index.html` inspected; interactive
preview opened at `http://127.0.0.1:8111/v2/`). The user explicitly approved the pending Place
interaction. Mock fixtures and placeholder dialogs were not copied into application behavior.

- One Item-details target contains title, note preview, progress, Place and Sub-items summary,
  with the existing `space[2]` / 4pt vertical gaps. Titles and addresses wrap fully.
- Rows retain their 72pt minimum, separators, token typography, and 44pt controls. Vertical
  padding is 12pt. Separate targets have at least 8pt between them, including the reorder grip.
- Maps is a separate existing MapPin icon using the existing platform-map function. Grouped
  staged rows now receive the Maps callback; it was missing before this change.
- Checkbox optimistic logic, feature eligibility, stage filters and explicit state changes,
  Plan links, reorder/persistence/permissions and secondary Item editors remain in their existing
  implementations. Note previews remain one line; full notes are available in Item details.

Narrow updates: `plans-and-lists.md` §§5.6, 5.7, 9.4; `interaction-contract.md` §§3.2, 6.2;
`design-system.md` §7.2b. Activity-detail address behavior and generic row title rules are unchanged.
No agent/workflow/skill instructions changed.

## Environment and identity

- Clean baseline: `b875a834ebc924e239d2a6e513b0c72daf6465ac`, branch
  `codex/fix-ios-startup-maestro`. Other build/mock tasks were idle before resource use.
- macOS 26.3; Xcode 26.6 (17F113); Node 22.23.2; pnpm 9.15.9; Maestro 2.10; Java 17.
- iPhone SE 3 simulator, 375×667pt, iOS 26.5, `OD Notes Small Screen`,
  `A254CB61-7B64-4767-B349-4A6971F5771E`. Only this resettable test device was cleared.
  The two other simulators and their application data were preserved.
- App: `app.ordinarydays.ios.local`, Release, local profile, version 0.1.0 (1), API proxy 13000 /
  API 13001 / control 18474. Existing isolated native test stack reused; ordinary user stack untouched.
- Native build checkout: `/private/tmp/ordinarydays-maestro-20260904`; source copied before builds.
  Final executable and bundle SHA-256 plus exact source hashes: [build identity](../generated/list-row-spacing-20260905/build-identity.json).
- Final JS bundle SHA-256: `38652595a8ccaab4784ba4eb5213b5bc09ed977ecdf0ff6cda231b2334e89c2d`.
  Three successful native builds were needed: initial layout, style review, final grip separation.

## Before and after

Same seeded List and items, same simulator and normal text setting:

| Before | After |
| --- | --- |
| ![Before](../generated/list-row-spacing-20260905/screenshots/native-before.png) | ![After](../generated/list-row-spacing-20260905/screenshots/native-after.png) |

The compact group is not a promise of fewer total pixels for every row: separate supporting
lines, fully wrapping titles/addresses and accessible controls can make a rich item taller.
The result keeps related text together and preserves clear boundaries between items.

## Regression evidence and attempts

All raw logs, screenshots, hierarchy dumps and command artifacts are preserved in
[the artifact directory](../generated/list-row-spacing-20260905/). Original working artifacts:
`/private/tmp/od-list-row-spacing-20260905/`.

| Check / attempt | Result and classification |
| --- | --- |
| `unit-red.log` | 15/16 passed; new approved body-destination regression failed: only title/note opened details, not progress/address/Sub-items. Expected red before correction. |
| `staged-maps-red.log` | Missing grouped-stage Maps callback reproduced. Also caught a transient title-style mistake in the implementation; both corrected. |
| `unit-green.log`, `unit-reviewed.log` | 35/35 passed after correction and style review. |
| `web-red.log`, `web-red-2.log` | Test setup errors: omitted idempotency key, then omitted If-Match version. Corrected to the API contract; neither was an application failure. |
| `web-red-3.log` | Real rendered spacing regression: title→note was 0px rather than 4px; screenshot retained before correction. |
| `web-green.log` | Pilot passed after layout correction. |
| `web-matrix.log` | 27/30 passed; three new Places assertions incorrectly assumed the preset had no checkbox. Corrected expectations to the actual List configuration. |
| `web-matrix-2.log` | 19/19 row cases passed. |
| `web-final.log` | 30/30 passed on final source, including axe and grip separation: 19 row cases and 11 neighboring Item/Plan/worked-example journeys. |
| `native-mixed-1.log` | Setup failure: Maestro does not expose `http.patch`; changed to documented generic `http.request`. |
| `native-mixed-2.log`, `native-mixed-3.log` | Maps first-use location prompt blocked return / following run. Hierarchies prove the prompt remained onscreen. Dismissed on the test simulator and added explicit first-use handling. Foreground return now uses `stopApp: false`. |
| `native-mixed-4.log` | Missing-detail text selector tapped its checkbox rather than body. Replaced with stable body ID; no application change. |
| `native-mixed-5.log` | Mixed journey passed. Later strengthened checks found a previously unmeasured gap defect, so this was not final acceptance. |
| `native-matrix-results.txt` | Six initial parameterized journeys passed before final grip correction. |
| `native-grip-red.log` | Required geometry check reproduced 0pt separation from the reorder grip. Added an 8pt token margin to the List item. |
| `native-final-mixed.log` | Final build passed mandatory finite viewport/target geometry, checkbox independence, details, positive Maps address destination and return, and missing-detail scrolling/opening. |

The [Maestro HTTP documentation](https://docs.maestro.dev/maestro-flows/javascript/make-http-requests)
supports the generic request method used for PATCH. No arbitrary sleeps or pass-until-green retries
were introduced. Conditional onboarding handling responds to an observed system screen.

## Coverage and verification

New executable coverage:

- `ListItemRow.test.tsx`: every supporting line opens details; Maps and checkbox are independent.
- `ListDetailScreen.test.tsx`: configured Place remains functional on a grouped staged List.
- `list-row-spacing.spec.ts`: mixed-feature measured 4px gaps; six presets in light/dark/200% browser
  text stress, 375/320px viewports, populated/missing/long content, complete title/address bounds,
  44px controls, 8px grip separation, keyboard focus ring, axe, filter immutability, checkbox state,
  actual map URL, Item details and persistence after reload.
- `list-row-spacing.yaml`: independently seeded/cleaned native journey, configurable through
  `ROW_KIND` (default mixed). Native helper uses the observed XCTest wire schema to require valid
  viewport/control geometry and separation. Maps asserts the observed `990 Washington Ave` result.

Required repository verification passed: `pnpm verify`, 6,003 tests plus lint/typecheck,
E2E typecheck, coverage, dependency boundaries, forbidden-pattern and dependency-version checks.
After the final style/gap and test-review changes, lint, both typechecks and all 504 List tests
passed again. Shared scope guards: 4/4. OpenAPI generation check: unchanged.
The native builds passed compilation. Final build identity above does not imply device acceptance.

Final native results: all six row configurations passed on the final build, as did mixed light,
mixed dark and the largest non-accessibility text setting (XXXL). AX5 initially failed in the
new test's default scrolling command: the fixed header ended at y=455, while Maestro swiped from
screen center y=333, outside the scroll area. The saved hierarchy showed 0% scroll despite twelve
pages of content. The corrected test starts inside `list-detail-body`, bounds its gestures by the
measured content/viewport sizes, and retains a positive row-open assertion. AX5 then passed from
fresh data (`native-final-ax5-2.log`). Normal mixed and grouped-stage journeys also passed again
with the final scroll helper (`native-scroll-results.txt`). This is a documented test-gesture correction, not an
unqualified pass-on-retry. [Maestro's fragment scrolling guidance](https://docs.maestro.dev/examples/recipes/custom-scrolling-for-screen-fragments)
describes the same center-screen limitation.

The AX5 header remains visually very tall and its List title uses the existing two-line clamp;
only 212pt of this SE viewport remains for scrolling. The journey proves the content is reachable,
not that this existing header is an optimal large-text design. Header redesign was outside this
row-spacing change. See the retained AX5 screenshots before accepting maximum-text aesthetics.

### Visual snapshot baseline blocker

The original, final-source visual suite and a clean archived baseline each returned **7 passed / 46 failed**.
Every failure was a pixel-snapshot comparison. Broad typography differences appear on untouched
screens as well as on intentionally changed rows. The untouched overview's actual PNG is exactly
the same in both checkouts (SHA-256
`ca123ed8468a64450a2c7e8600d8d9500ddbbd879cad3972566ea9ea7ef49506`).

Observation: the mismatch predates this task. Hypothesis: the committed snapshots were produced
under different typography/rendering conditions; its exact origin was not established here.
No unrelated snapshots were overwritten and no comparison threshold was relaxed. The clean
baseline needed two setup corrections before its run: symlinked dependencies were outside
Metro's resolution scope, then generated shared-package output was missing. Those attempts are
retained as `visual-baseline.log`, `visual-baseline-2.log`, `visual-baseline-3.log`.

## Changed files

- Production: `apps/mobile/src/features/lists/components/ListItemRow.tsx` (grouping, wrapping,
  independent Maps target, grip separation, memoized token styles) and `ListDetailSurface.tsx`
  (grouped-stage Maps wiring).
- Component regression tests: `ListItemRow.test.tsx`, `ListDetailScreen.test.tsx`.
- New browser journey: `e2e/specs/list-row-spacing.spec.ts`.
- New native journey and helpers: `apps/mobile/e2e/list-row-spacing.yaml`,
  `scripts/list-row-setup.js`, `scripts/list-row-cleanup.js`, `scripts/assert-list-row-layout.js`.
- Three canonical contract documents listed above and this evidence report.
- No application domain/storage/network schema changes, no new dependencies, no snapshot baseline edits.

Full diagnostic archive: [artifacts.tar.gz](../generated/list-row-spacing-20260905/artifacts.tar.gz).
The final-source [patch](../generated/list-row-spacing-20260905/source.patch) includes new files.

## Review and remaining acceptance

Independent standards and specification reviews found and closed: two stale Place contract clauses,
inline row style allocation, missing axe calls, conditional native geometry checks, and a negative-only
Maps check. The strengthened native check exposed the grip gap, which was fixed with regression
proof. Reviewers reported no remaining concrete production/specification findings.

Physical iPhone acceptance, actual VoiceOver speech/rotor/gesture behavior, and native hardware-keyboard
focus are not verified. Accessible labels/order and bounds were inspected through native accessibility
APIs; those checks do not substitute for VoiceOver acceptance. No new native drag gesture was tested;
existing reorder tests and the wrapper implementation were preserved. No Android acceptance run.
No full unrelated Maestro catalogue run was performed for this scoped row change.

Workflow observations: the approved Place decision was the only product clarification. Several new
harness mistakes cost repeat work; all are recorded above. The clean-baseline comparison prevented
unrelated visual snapshot replacement. Elapsed sampling/token usage is not available as a reliable
measurement; none is claimed. Proposed follow-up: standardize the visual baseline's font/runtime
identity and provide reusable contract-aware native List fixtures. These workflow changes were not applied.
