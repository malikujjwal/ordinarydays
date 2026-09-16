# Destination-flow simplification — proposal, 2026-09-16

**Status: proposal, not approved. Changes no code, no schema, no stored data.** This report
recommends nothing be built yet; it exists so the founder can decide, with the evidence in
one place, whether the "where do these items go?" flow should be simplified. Two real bugs
in it were found during manual testing and are already fixed on `integration/activity-detail-fixes`
(commits `cf71244`, `536ce7d`, `e53911d`, `a4fedb5`); this report is the follow-up question
they raised, not a description of outstanding defects.

## 1. What the user sees today, and the two traps

Adding ingredients from a Meal, or a list item from a Watch Plan, asks one implicit
question — "which list?" — through a **slot**: `groceries`, `watch` or `meals`
(`packages/shared/src/types/user.ts:31`). The flow, from `docs/01-product/plans-and-lists.md`
§5.8 and §7.3:

1. The section shows selectable rows and a destination line naming a list, changeable via a
   `▾`.
2. If exactly one eligible list exists, it is used silently. If several exist with a saved
   default, the default is shown. If several exist with no default, a one-time sheet asks
   and offers `Remember this choice` (checked by default). If none exist, the row reads
   `Choose or create a list`.
3. The `▾` opens `DestinationSheet`, which can also show **`Choose another list`** — every
   other list the viewer holds, not just ones marked for this slot — and **`New list`**,
   which opens the seven-type creation catalogue.

**Trap 1 (fixed in `cf71244`/`536ce7d`/`e53911d`).** The most obvious thing to create is
**Blank** (`defaultTitle: 'Untitled list'`, `packages/shared/src/lists/templates.ts:9-11`),
and it was the one type that could never receive ingredients — the picker offered it, the
API refused it (`services/api/src/services/ingredientsToListService.ts:857`, message
`'Ingredients can only be added to a simple list.'`), and setting that same list's `slot` to
`groceries` did not change the outcome, because `slot` and capability are unrelated fields.
This was reported live: create an "Untitled list", add ingredients from a Meal to it, get
refused.

**Trap 2 (fixed in `a4fedb5`, unrelated to Trap 1).** Tapping `New list` from that same
picker did nothing and blocked the screen. `packages/ui/src/primitives/Sheet.tsx:425` keeps
a sheet's modal mounted through its exit animation, and `DestinationSheet` opened the
`NewListSheet` the instant the button was tapped, before the first sheet had finished
leaving — two modals mounted at once, the exiting one still capturing taps. This is a
**Sheet-lifecycle bug**, present since the flow was built (`7c0b096`, already on `main`) and
independent of slots or capability; the sibling picker `AddListToPlanSheet.tsx:63-71`
already used the correct sequencing (`onClosed`), which is what the fix copied. It is called
out here only because it is part of why the flow read as more broken than it structurally
is — the destination model itself did not cause the deadlock.

## 2. The current model

| Concern | Question it answers | Vocabulary | Who enforces it | Where |
| --- | --- | --- | --- | --- |
| Routing | Which list did the user mean, of several equally valid ones? | `slot: 'groceries' \| 'watch' \| 'meals' \| null` on `List`; `user.defaultLists` | `resolveSlot`'s four-step rule | `packages/shared/src/lists/resolveSlot.ts` (106 lines), ADR-033 |
| Capability | Can this specific list structurally hold what is being added? | `itemStateMode.mode: 'none' \| 'checkbox' \| 'stages'`, `featureConfig.*` | The API write guard, now re-exposed to the client | `services/api/src/services/ingredientsToListService.ts:857`; shared predicate `packages/shared/src/lists/ingredientDestination.ts` |
| Creation | What kind of list may the user make here? | `templateKey`, one of seven fixed presets | The creation catalogue, filtered per flow | `packages/shared/src/lists/templates.ts` (98 lines), `templateChoices.ts` (75 lines) |

Three concerns, three vocabularies, one underlying question — "what is this list for, and
can it do this?" Nothing before today's fix enforced that the three answers agreed for one
list, and the type system could not: a `List`'s `slot` and its `itemStateMode` are
independent optional fields (`packages/shared/src/schemas/list.ts`), settable separately in
list settings, with no cross-field refinement.

This is not the model's first shape. ADR-031 (2026-08-07) replaced an eight-value `ListKind`
enum with three coarse `ListBehaviour`s (`collection`, `watch`, `meals`) to stop behaviour
and presentation from being the same field. ADR-058 (2026-08-28, **Accepted, supersedes
ADR-031**) replaced *that* with the current `itemStateMode` + keyed `featureConfig` shape,
specifically because whole-list behaviours still coupled optional typed data (Watch
progress, meal ingredients) to presentation. ADR-058 explicitly considered and kept slots
separate: *"Slots remain independent semantic routing declarations."* The three-vocabulary
shape examined here is not an oversight that survived unnoticed — it is the second
architecture in this area, and the separation of routing from capability was a deliberate,
recorded decision made the last time this exact area was redesigned.

## 3. Why this is the root of the bug class (Trap 1's family, not Trap 2's)

The predicate drift is not hypothetical — it is what shipped, three times, before it closed:

- Before `cf71244`, `DestinationSheet`'s `Choose another list` rendered `destination.all`
  with **no eligibility check at all** — every non-archived list, capable or not. The escape
  itself is specified on purpose (`phase-03-plans-and-lists.md:3219-3220`: *"the picker lists
  only lists whose `slot` matches, plus a `Choose another list` escape that opens the full
  index. A user is allowed to put ingredients in a list that is not marked as a
  destination"*) — its breadth was intentional; its missing capability floor was not.
- `cf71244` unified capability behind one shared predicate (`canReceiveIngredients`,
  consumed by both the API guard and the client). A first-pass fresh review rejected it: on
  native, `useEligibleLists` read only the TanStack/API cache
  (`apps/mobile/src/hooks/useEligibleLists.ts`), while native list settings and creation
  commit straight to SQLite (ADR-057) — so a list just changed or just created locally could
  be invisible or stale in the picker.
- `536ce7d` added a native-authority hook reading the subscribed SQLite projection
  (`apps/mobile/src/hooks/useEligibleLists.native.ts`, 129 lines). A second review rejected
  *that*: between a local commit and its queued sync reaching the server, the send path
  could still act on the old snapshot.
- `e53911d` added send-time revalidation against the committed local projection.

Three commits and two rejected reviews were needed to make one predicate agree with itself
across the API, the web client and the native client — for a rule that is, in the end, one
line (`itemStateMode.mode === 'checkbox'`). That cost is evidence about the shape of the
problem, not about the quality of any one fix: every one of those defects existed because
capability is *computed*, redundantly, in three runtimes, from fields that live in two other
vocabularies, rather than being one fact the server states and everyone else reads.

## 4. Cost today (measured)

Core destination-routing files, current tree:

| File | Lines |
| --- | --- |
| `apps/mobile/src/hooks/useDestination.ts` | 100 |
| `apps/mobile/src/features/lists/components/DestinationSheet.tsx` | 184 |
| `apps/mobile/src/features/lists/components/NewListSheet.tsx` | 251 |
| `apps/mobile/src/lib/destinationCopy.ts` | 63 |
| `apps/mobile/src/lib/destinationCapability.ts` | 26 |
| `packages/shared/src/lists/resolveSlot.ts` | 106 |
| `packages/shared/src/lists/templates.ts` | 98 |
| `packages/shared/src/lists/templateChoices.ts` | 75 |
| `packages/shared/src/lists/ingredientDestination.ts` | 17 |
| **Implementation subtotal** | **920** |
| `apps/mobile/src/hooks/useDestination.test.tsx` | 234 |
| `apps/mobile/src/features/lists/components/DestinationSheet.test.tsx` | 211 |
| `apps/mobile/src/features/lists/components/NewListSheet.test.tsx` | 374 |
| `packages/shared/src/lists/__tests__/resolveSlot.test.ts` | 191 |
| `apps/mobile/src/hooks/useEligibleLists.native.test.tsx` | 287 |
| **Test subtotal** | **1,297** |
| **Total, 14 files** | **2,217** |

This excludes the API guard and its tests, `useEligibleLists.ts`/`.native.ts` themselves (73
lines, required independently by ADR-057 — see the note below), and the three screens that
consume the hook (`IngredientsSection.tsx`, `ComposeScreen.tsx`,
`apps/mobile/src/components/WatchListDestination.tsx`). All figures above were measured with
`wc -l` against the current tree, not estimated.

**Concepts a user or a future implementer must hold to reason about this flow correctly:**
three slots; a per-slot remembered default (`user.defaultLists`, a profile write only the
`ask` case makes); a per-operation one-off override that never touches the default; three
item-state modes, only one of which is a valid ingredient destination; a per-flow capability
rule (ingredients require checkbox, Watch requires none); a seven-template creation
catalogue, filtered differently per flow; and an escape hatch that bypasses routing but not
capability. Most of this is implementation detail invisible to the user in the common case
(one eligible list, used silently); the user-facing residue is the type catalogue, the
one-time question with its `Remember this choice` checkbox, and `Choose another list` — and
Trap 1, where "the obvious choice doesn't work," is the part of this that actually reached
the user.

**Correction to an earlier informal claim in this thread:** the native SQLite-authority hook
(`useEligibleLists.native.ts`) is not itself a cost of the slot/capability split. ADR-057
requires native reads to come from the local projection regardless of what capability looks
like; that hook, or something equivalent to it, would be needed even in a single-vocabulary
model, because *any* list property read into a destination decision needs the same
local-authority treatment. What the split cost was the *predicate* duplicated inside it, and
the two-commit repair when that predicate disagreed with the server's.

## 5. Options

### Option A — Minimal: keep slots, delete client-side knowledge of `itemStateMode`, drop the escape hatch

**What the user sees:** unchanged for the common cases (one/several/no eligible list). `New
list` still filters the catalogue by capability (already true today). `Choose another list`
is removed: the picker only ever offers lists that hold the relevant slot.

**Deleted:** `showAll` state, the `CHOOSE_ANOTHER_LIST` button and `destination.all` from
`DestinationSheet.tsx`/`useDestination.ts` (~20-30 lines); the corresponding test cases.
`destinationCapability.ts` and `ingredientDestination.ts` stay — they are what makes the
creation catalogue and the API guard agree, and that part is working.

**Added:** nothing.

**Migration:** none. No stored field changes; `slot` and `itemStateMode` keep their current
meaning and independence.

**Doc/ADR impact:** removes the escape hatch that `docs/03-implementation/phase-03-plans-and-lists.md:3219-3221`
explicitly specifies (*"a user is allowed to put ingredients in a list that is not marked as
a destination"*) and that `plans-and-lists.md` §5.8/§7.3 describe as `Choose another list`.
This is a **product decision**, not a cleanup — P3-43 chose it on purpose, and removing it
needs the founder's sign-off, not just an implementer's.

**Risk:** low, mechanical. The remaining surface (slot, default, one-time question,
catalogue) is unchanged and already correct after today's fixes.

### Option B — Flatten: one server-provided capability, one flat picker, no slot vocabulary in the UI

**What the user sees:** a single picker listing every list capable of the write, sorted by
however lists are normally sorted, with the current/last-chosen one preselected if one is
set; no `Remember this choice` checkbox; no slot-shaped one-time question; `New list` filtered
by the same capability.

**Deleted:** `resolveSlot.ts` and its test (297 lines), the `ask`/ `use`/`none`
three-state machinery in `useDestination.ts`, `destinationQuestion`/`destinationLead`'s
slot switches in `destinationCopy.ts`, the `Remember this choice` control and its mutation in
`DestinationSheet.tsx`, `user.defaultLists` as a routing concept (see below). Net: most of
`useDestination.ts` (100 lines) and `resolveSlot.ts` (106 lines) go away; `DestinationSheet.tsx`
shrinks by removing the `ask`/`remember` branches.

**Added:** one derived capability, computed server-side from the same two fields
(`itemStateMode`, `featureConfig`) already used today, exposed as part of the `List`
response shape — e.g. `capabilities: { ingredients: boolean }`. This is a **pure function of
existing stored fields**, so it needs **no data migration and no schema change to stored
rows** — only a response-shape addition (same shape `ingredientDestination.ts` already
computes, moved server-side and to more capabilities than one). `templateChoices.ts` would
compute the equivalent for templates, as it already does.

**Migration/compatibility concern, load-bearing:** `user.defaultLists` and `slot` are the
routing mechanism ADR-033 (Accepted, 2026-08-07) put in place, explicitly **rejecting**
"most-recently-used" as a destination rule (*"Destinations must be chosen, not
accumulated"*). Option B's flat picker needs to pick a default somehow. Two honest
sub-options, not one:
  - **B1 — keep an explicit default, drop the ceremony.** The picker still preselects
    `user.defaultLists[capability]` when set, with no "remember this choice" question — the
    first time a capable list is chosen, it silently becomes the default (or the user sets
    it from list settings, per today's §5.5). This is compatible with ADR-033's actual
    decision (a chosen default, changeable per-operation) and only removes the "ask and
    checkbox" ceremony ADR-033 did not require.
  - **B2 — default to last used.** Simpler to explain, but this is **the specific
    alternative ADR-033 rejected by name**. Adopting it is not a refactor; it is reopening
    ADR-033 and needs to be recorded as a new decision, not inferred from this report.
  This report recommends B1 if Option B is chosen, and flags B2 as a question for the
  founder in §8, not a default answer.

**Doc/ADR impact:** supersedes ADR-033's four-step resolution decision (`decisions.md:1049-1098`,
prose, not a table — the table restating it lives in `plans-and-lists.md` §5.8) and that
section's "In the flow" walkthrough; amends P3-12 and P3-43 in `phase-03-plans-and-lists.md`.
This is the same class of change as ADR-058 was to ADR-031 — a second redesign of the same
area within roughly six weeks of the last one.

**Risk:** medium. Touches three consumers (`IngredientsSection.tsx`, `ComposeScreen.tsx`,
`WatchListDestination.tsx`) and all of `useDestination.test.tsx` (234 lines),
`DestinationSheet.test.tsx` (211 lines) and `resolveSlot.test.ts` (191 lines) need rewriting
rather than incremental edits. Because capability becomes one server field instead of a
client-computed predicate, this is also the option most likely to make Trap 1's bug class
*structurally* impossible rather than merely fixed — there is no longer a second place for
the rule to disagree with the first.

### Option C — Keep as-is; document only

No code change. This report itself, cross-linked from `plans-and-lists.md` §5.8 and
`ingredientDestination.ts`'s doc comment, becomes the record of why the three vocabularies
must agree and where each one lives, so the next feature that needs a destination (a fourth
slot, per ADR-059... no such ADR exists for slots; per the closed-set decision in
`docs/00-open-decisions.md` #21) copies the discipline `cf71244` established rather than
re-discovering it by drift.

**Risk:** the discipline depends on every future change remembering to update the shared
predicate; today's bug is evidence that "remember to keep two things in sync" already failed
once, in code written for exactly this purpose. Cheapest option; does not reduce the 2,217
measured lines or the concept count in §4.

## 6. Recommendation

Ship what is already committed (it makes the *current* model correct, and Trap 1 cannot
recur in the current shape) and do not revert it regardless of what happens with this
proposal. Beyond that:

- If the priority is finishing the current feature set and moving on: **Option A**. It is a
  same-day change, removes the one piece of the current model (`Choose another list`) that
  has no capability floor even after today's fix, and touches no ADR the founder has not
  already amended once today (`plans-and-lists.md` §5.8/§7.3 already carry the "limited to
  list types that can hold the pending items" wording from `cf71244`).
- If the priority is the flow being obviously right to a new user, and the founder is
  willing to reopen ADR-033/ADR-058's territory a second time in six weeks: **Option B**,
  specifically B1. This is a bigger, riskier change (medium risk, ~2,000 lines touched
  across implementation and tests, three ADR-adjacent documents amended) for a real gain:
  one vocabulary instead of three, and a bug class that becomes structurally impossible
  rather than fixed by discipline.

**The honest counter-argument to doing anything at all right now:** the current model is
correct as of `e53911d` — every gate this report's author could run is green, and the
specific bug reported (Trap 1) cannot reproduce in the current tree. ~2,217 measured lines
and two accepted ADRs (033, 058) already encode this shape, the second of which explicitly
chose to keep slots and capability separate after evaluating the alternative. A third
redesign of the same territory inside one testing session has its own risk: the last
redesign (ADR-058) took a dedicated pass with visual-regression gates: *"first baselines are
approved side-by-side with the founder reference, then path-filtered pixel gates protect
them"* — this is not a same-day change even at Option A's size, and Option B is materially
larger than Option A.

## 7. Open questions only the founder can answer

- Does remembering a destination per category earn its keep, or would a flat "last list you
  put groceries in" (Option B2, reopening ADR-033's rejected alternative) actually match how
  you expect the app to behave? The two are different product decisions, not a wording
  choice.
- Should `Groceries`/`Watch`/`Meals` ever be words the user sees, or should the picker be
  fully generic ("choose a list") with the slot only a routing detail the user never
  encounters? Today it is a mix: the slot name appears in destination copy
  (`destinationCopy.ts:32-40`) but not in settings row labels beyond "Groceries, Watchlist,
  Meals" (§5.8, "In settings").
- May a Blank list later gain checkboxes (an explicit settings change, per ADR-058's
  "mode/feature settings are immediate, reversible") and thereby become a valid ingredient
  destination without being recreated? This is already true today (change the list's item
  state mode in settings) — worth confirming it is the intended fix for a user who hits
  Trap 1's pattern, versus creating a second list.
- Is `Choose another list` (Option A removes it, Option B replaces it with "every capable
  list is just in the picker") worth keeping as a named escape at all, given P3-43 chose it
  deliberately once?
- Is a second architectural pass over this area, six weeks after ADR-058, worth the review
  and visual-regression cost ADR-058 itself required, or should this wait for more usage
  evidence (the same "revisit if users keep recreating the same configuration" standard
  `docs/00-open-decisions.md` #18 already applies to templates)?

## 8. Non-goals — what must not change regardless of which option is chosen

- The shared capability predicate (one authoritative rule, read by the API guard and every
  client) — this is the part of today's fix that is correct in every option above, including
  "do nothing further."
- Always naming the destination before a write (ADR-033's consequence: *"the sheet must show
  the resolved destination even when it did not ask"*) — every option above preserves this.
- The server as the last line of enforcement, independent of what the client offers.
- Suggest, never auto-create: creating a Meal or a Watch Plan still writes zero list items
  until a named confirmation (`ingredientsToListService.ts`'s own doc comment; P3-43's
  "nothing is written until the button... is confirmed").

## 9. Cost estimate of Option B, if chosen

- **Files touched:** `useDestination.ts`, `resolveSlot.ts` (deleted or reduced to a
  single-list-vs-none fallback if any caller still needs "silently use the only option"),
  `destinationCopy.ts`, `DestinationSheet.tsx`, `NewListSheet.tsx` (capability plumbing
  already generic), `templateChoices.ts`, the three consumers
  (`IngredientsSection.tsx`, `ComposeScreen.tsx`, `WatchListDestination.tsx`), the API
  response shape for `List` and its schema/type, and `packages/shared/src/lists/ingredientDestination.ts`
  generalised to cover Watch's capability too (today Watch has none — confirm B does not
  need to invent one).
- **Tests to rewrite rather than extend:** `useDestination.test.tsx` (234 lines),
  `DestinationSheet.test.tsx` (211 lines), `resolveSlot.test.ts` (191 lines) — 636 lines of
  test surface built around the four-step/three-vocabulary model would need re-authoring
  against the flat model, not patching.
- **Docs/ADR to amend:** a new ADR superseding ADR-033's resolution table (058-style,
  "Supersedes ADR-033"); `plans-and-lists.md` §5.8 rewritten; §7.3 step 2 and §8.1's
  destination paragraph updated; `phase-03-plans-and-lists.md` P3-12 and P3-43 task
  descriptions amended or marked delivered-then-superseded.
- **Not estimated here, and material:** UI/visual-regression review of the flattened picker,
  which ADR-058's own consequences section treats as required for a change of this shape
  ("visual fidelity is contractual... first baselines are approved side-by-side with the
  founder reference"). This report does not estimate that cost; it is a separate piece of
  work this report recommends scoping before starting Option B, not folding into it silently.
