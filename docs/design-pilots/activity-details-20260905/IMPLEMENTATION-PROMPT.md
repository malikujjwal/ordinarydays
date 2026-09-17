# Implementation prompt — Activity detail: render and edit the type-specific details

Hand this to a fresh supervisor session. It is a prompt, not a contract: the canonical rules
are `CLAUDE.md`, the docs it routes to, and `docs/agents/workflow.md`.

---

## The prompt

Implement the type-specific Activity details on the Activity detail screen, from mock v2.

**Authority.** The founder commissioned this implementation on 2026-09-09, and explicitly
approved the `ADD TO THIS TASK` row. That accepts the *direction* — it does not approve every
proposal inside the mock. The items under "Raise, do not resolve" are still open, and the doc
amendments listed below are still owed. If a decision you need is not written down here or in
the mock README, ask; do not infer it from the mock rendering a particular way.

**The mock:** <https://claude.ai/code/artifact/a557fd92-4e51-4bcd-9a2c-944fb937959b>
(private to the founder's account — open it in a signed-in browser). The same page is in the
repo at `docs/design-pilots/activity-details-20260905/activity-mock-v2/index.html`; serve the
pilot folder with the `design-pilot` entry in `.claude/launch.json` and open
`/activity-mock-v2/`. **Read
[`activity-mock-v2/README.md`](activity-mock-v2/README.md) before anything else** — it carries
the design rationale, the decisions, and thirteen items that must be raised rather than
resolved.

**The problem.** `apps/mobile/src/features/activity/components/ActivityDetailScreen.tsx` touches
`activity.details` in exactly two places, both meal ingredients (`:1729`, `:1732`). Every other
type-specific field is captured by `compose/forms/TypedFields.tsx`, validated, stored, returned
by `GET /v1/activities/:id`, and never drawn. `sourceUrl`, the `listId`/`listItemId` backlink and
the parent plan's name are unrendered too. The sharpest symptom: a Watch row on Today reads
`Watch · S2 E4`; tap it and the season and episode disappear.

**This is its own scope.** No phase task owns it — do not invent a phase ID
(`docs/agents/workflow.md` step 1). P3-43 built the ingredient and watchlist *pickers* on the
compose side, not this.

### Run it as an orchestrated implementation

`AGENTS.md` and `docs/agents/workflow.md` §"Implementation ownership" govern. The parent
supervises and does not write the feature.

1. **Scout** (read-only) — the contracts, one real path from screen through
   `useActivity` → shared client → `activityService` → `activityRepository`, the acceptance
   conditions, the exclusions, the verification commands, and the files in play. No edits.
2. **Oracle** (read-only) — direction and material tradeoffs from the scout's evidence,
   specifically: where the `Edit` affordance lives, whether the sheet is one per type or one
   per group, how the wholesale-`details` replacement is made safe, and what the empty case
   costs. The parent accepts or rejects the direction before any worker writes.
3. **Worker** — bounded behaviours in an isolated worktree; tests and verification commands
   travel with the change. See the slicing below.
4. **Reviewer** (fresh context, read-only) — standards and specification against a pinned
   revision. The `code-review` skill applies, so use its two review subagents.
5. **Parent** — accept, reject, or apply a small stated fix. Do not silently redo the worker's
   work.

### Do this first — it blocks the edit UI

**A details-only `PATCH` is not validated against the activity's current type.**
`checkDetailsMatchType` runs only when the patch also carries `type`
(`packages/shared/src/schemas/activity.ts:620`), and an edit sheet sends `details` alone —
exactly the shape nothing has ever sent. Reading `merge` (`activityService.ts:1224`, called from
`patchActivity` at `:956`), a mismatched `details.kind` looks storable, and
`activitySchema.parse` on read (`activityRepository.ts:683`) would then reject the row, turning
a bad write into a broken read. Every `details:` case in `patchActivity.test.ts` sits inside the
kind-change block; there is no test for a details-only patch at all.

Reproduce it with a failing test first. If it is already refused, say so and keep the test. The
guard belongs server-side in `patchActivity`, next to `assertCoverIsLinked` (`:951`) — the
schema cannot do it, because it does not know the activity's current type.

### Slices

Take them in this order; each is a shippable behaviour.

1. **The guard above**, plus its test.
2. **Read-only rendering** — the subtitle grammar, the type sections, the `LINK` section, and
   the `Related plan` / `From <list>` rows. Needs slice 3 for the two titles.
3. **`ActivityDetail` gains the parent's title and the source list's title.** Both navigation
   rows are otherwise unnameable, and a row that navigates somewhere it cannot name is worse
   than no row — if this cannot land, hold those two rows. Precedent for the shape: the List
   side renders a stored, server-written `sourceLabel` (`listRepository.ts:2222`) rather than
   deriving it. Touches `packages/shared/src/types/` — say so in the PR title
   (`docs/04-conventions/git-workflow.md` merge-order rule) and run `pnpm gen:openapi`.
4. **Editing** — the section-level `Edit`, the per-type sheet, and the empty-state chips.
5. **Failure handling** — `If-Match`, the 409 path, and a draft that survives a failed save the
   way the notes editor's does (`activities.md` §6.1). The mock does not model this; it is not
   optional in production.

### What the mock settles

Read the mock README for the reasoning. In short:

- **Above the type sections everything is a control (`SettingRow`); inside a type section
  everything is content** (the 44 pt `SectionFrame` grammar `ListsSection`/`PrepSection` already
  use). `SettingRow`'s own doc comment (`packages/ui/src/primitives/SettingRow.tsx:14-18`)
  draws this line already.
- **Identity goes in the header's existing type-and-audience line**, not a section:
  `Meal · Dinner · Just you`, `Watch · S2 E4 · Just you`. §7.5 rule 1's own second slot.
- **Sections are topic-named** — `RECIPE`, `WATCHING`, `DESCRIPTION`, `RESERVATION`, `TICKETS`,
  `LINK` — placed after the settings group and before `PREPARATION`.
- **Editing is section-level**, one `Edit` in the `SectionFrame` trailing slot. Rows stay
  content: no chevrons, not individually tappable, so a tap on a link row still opens the link.
- **One sheet per type carries the whole `details` object**, because `PATCH` replaces `details`
  wholesale (`activityService.ts:1336`). A partial save silently drops the rest.
- **A movie renders no season or episode even when one is stored** — nothing clears them on a
  Show → Movie change.
- **Money is integer minor units in both directions.** Do not copy `formatPrice`
  (`changeActivityKind.ts:256`); `(cents / 100).toFixed(2)` is the construct `expenses.md` §3.1
  forbids. The mock's `money()` and `centsFromInput()` show the intended shape.
- **Reuse the existing user-facing labels.** `changeActivityKind.ts:151-254` is a
  hand-transcribed registry of every type-specific field with its label, deliberately literal
  because "the table is the contract". `patchChangeNames.ts:10` already names `sourceUrl` as
  `Link`.

**Founder decision, 2026-09-09: Task detail gains an `ADD TO THIS TASK` chip row.** `Link` is
the only chip it can ever carry — no prep children, no lists, no attachments.

### Doc amendments required in the same PR

A PR that leaves these stale is incomplete (`CLAUDE.md`).

- `today-and-tasks.md` §5.6 — still says Task detail has no such affordance.
- `design-system.md` §7.5 — the capability order names no type section, and neither the
  control-vs-content rule nor the section-level `Edit` grammar is written down.
- `plans-and-lists.md` §2.1 / the 2026-09-05 note — the `Add to this plan` chip list is
  enumerated closed as `Prep task`, `List`, `Photo`; type chips extend it.
- `plans-and-lists.md:543` — says Recipe "remains absent until [its] own product conditions and
  implementation are available".

### Raise, do not resolve

The mock README lists thirteen. These four change what you build, so surface them to the founder
rather than picking:

1. **§5.3 does not match either implementation.** Both `deriveSubtitle` copies
   (`activityRepository.ts:240`, `agendaProjection.ts:95`) emit a `Watch ·` prefix the table does
   not have, and no `service` fallback. The mock also extends §5.3 to render `S3` for a season
   alone, and drops §5.3's `locationLabel` fallback on detail.
2. **Season/episode ranges disagree** — `activities.md:404-405` says 0–99 / 0–999,
   `schemas/common.ts:121-122` allows 0–1000 / 0–10000.
3. **`priceCents === 0`** → `0.00 GBP` or `Free`?
4. **`Watchlist title` vs `Saved as`** for the diverged `mediaTitle`.

Also: `fix/P3-49-sourced-list-backlinks` is in flight for `listId`/`listItemId` — coordinate
before touching that path.

### Out of scope

Expenses, People/participants, the Updates feed, attachments beyond what exists, and any
redesign of the header, the schedule row, the completion action or the notes editor. Do not add
an `Edit` to the `⋯` menu as part of this — `interaction-contract.md` §1 U6 anticipates it, but
it is a separate decision.

### Verification

From `docs/agents/workflow.md` §"Verification matrix":

- `pnpm --filter @od/api exec vitest run` for the guard; `@od/mobile` and `@od/shared` for their
  slices.
- `pnpm verify` before the PR.
- `pnpm test:int` for the storage/API path.
- `pnpm gen:openapi` then `pnpm gen:openapi:check` if the envelope changes (slice 3).
- `pnpm e2e:web` for the web journey.
- **Native evidence is required** for the sheet: keyboard avoidance, Dynamic Type, VoiceOver
  grouping of the fact blocks and the sheet's focus trap, and real gestures. A green web run
  does not establish any of it, and a compilation result closes compilation only.

Report against the definition of done, naming the revision, the commands, the results, and every
unrun gate.
