# Phase 2.5 — Recurrence stabilization

## Goal

Phase 2.5 is a blocking correctness gate between Today/tasks and all later product work.
At its end, the words **series**, **occurrence**, **does not repeat**, **no end**, and
**end series** each name one operation throughout the product, API and client. No write
infers an occurrence from an optional field or from whichever agenda window happens to be
cached, and the client no longer maintains a partial, divergent interpretation of a
recurrence mutation.

This gate was created after the 2026-08-13 recurrence audit found fifteen defects, twelve of
which came from optional occurrence scope. The pure expansion engine was not the failing
part: its property and boundary tests remained green. The failures lived at the seams between
the series Activity, virtual agenda occurrences, stored Occurrence overrides, detail state and
the eventually-consistent agenda index.

No remaining Phase 2 feature work and no Phase 3 implementation work begins until P2-52
through P2-55 are complete. Documentation and review may continue; code that consumes
completion, recurrence or agenda state waits.

## Founder decisions — 2026-08-14

These decisions supersede the short-lived 2026-08-13 interpretation that made Repeat →
`Never` an alias for End series.

1. **Does not repeat** removes `recurrence`. On a new draft it means no rule is written. On an
   existing series it is an explicit series-to-one-off conversion, never an alias for ending.
2. **End series** preserves `recurrence` and sets its inclusive `endDate`. It is a separate
   action.
3. **No end** is the Ends value that clears `endDate`/`count` and lets the series continue
   indefinitely. It is not labelled `Never`, because that word previously named two opposite
   operations in one sheet.
4. Converting an existing series to a one-off requires an explicit occurrence target. That
   occurrence's effective date, start time and end time become the Activity schedule; the
   stored timezone is retained. Every other generated occurrence stops rendering. Existing
   Occurrence rows remain stored but are no longer reachable through recurrence expansion.
5. If stored completion history will disappear from view, the standard destructive
   confirmation names the real count. A separate End series action remains available because
   it preserves history rendering.
6. A series-only detail screen never chooses today, the next cached occurrence or the most
   recent cached occurrence on the user's behalf. Occurrence actions require navigation with
   an explicit occurrence target. Series actions state their date explicitly.

## Deliverables

- [ ] One canonical vocabulary and operation table in the product and architecture docs.
- [ ] A discriminated target at every internal activity/occurrence call site; optional
      `occurrenceDate` exists only at the current HTTP and persisted-mutation compatibility
      boundaries.
- [ ] An authoritative occurrence detail projection containing effective date, time, end time,
      status **and outcome**, independent of agenda-cache warmth.
- [ ] A resolved row and a resolved detail screen that report the outcome the user chose,
      including a declined one, on a series occurrence as well as on a one-off.
- [ ] An atomic series-to-one-off conversion that retains the selected occurrence schedule.
- [ ] A distinct End series write and a distinct No end setting.
- [ ] Agenda reconciliation that cannot cache a pre-write GSI response over newer local state
      and does not attempt partial recurrence expansion in `applyPatch`.
- [ ] Cross-layer tests for create, edit-all-future, complete, reschedule, convert, end,
      restart, cold entry and offline replay.
- [ ] A one-time audit for recurring Activity rows carrying series-level `completed` or
      `skipped` status, with no invented occurrence history.

## Tasks

| ID | Title | Area | Depends on | Parallel-safe | Size |
| --- | --- | --- | --- | --- | --- |
| P2-52 | Canonical recurrence actions and Phase 2.5 gate | docs | P2-47, ADR-053 | no | M |
| P2-53 | Explicit occurrence detail target and authoritative projection | shared/api/mobile | P2-52 | no | L |
| P2-54 | Atomic recurrence writes and versioned agenda reconciliation | shared/api/mobile | P2-53 | no | L |
| P2-55 | Recurrence E2E matrix and damaged-series audit | api/mobile/ci | P2-54 | no | L |
| P2-56 | The resolved outcome on the occurrence and agenda projections | shared/api/mobile | P2-53 | yes | M |

The IDs continue Phase 2's `P2-xx` sequence so branch, commit and task tooling keep the
existing `P<phase>-<task>` contract. “2.5” is the execution gate and roadmap position, not a
new task-ID grammar.

> **P2-56 added 2026-08-15 (founder), and it does not extend the gate.** The blocking sentence
> above names P2-52 through P2-55 and still does. P2-56 completes a corner of P2-53's own
> deliverable — "the effective occurrence schedule **and resolution**" — that the built
> projection left out, and it is parallel-safe against everything else here.

---

### P2-52 — Canonical recurrence actions and Phase 2.5 gate

**Files.** This phase file, `docs/00-index.md`, `docs/03-implementation/roadmap.md`,
`docs/01-product/today-and-tasks.md`, `docs/01-product/activities.md`,
`docs/02-architecture/data-model.md`, and `docs/02-architecture/decisions.md`.

**What to build.** Record the six founder decisions above in the canonical product and
architecture documents. Reserve the visible choices **Does not repeat** and **No end** for
their distinct operations. Specify the conversion survivor, because “remove recurrence”
without saying which occurrence becomes the one-off is not an implementable operation.
Specify that End series is separate and inclusive.

This task does not add or relabel the write path. Until P2-54 lands, no UI may pretend an old
ambiguous write is the new atomic conversion; P2-54 changes the visible copy and behavior in
one reviewable unit.

**Tests.** Documentation links resolve and the existing shared scope ratchet remains green.

> **As recorded — 2026-08-17.** Most of this task's substance landed early, inside
> `fix: stabilize recurrence operations and reconciliation`, which changed the canonical docs
> and the P2-53/P2-54 code in one commit. The completing pass covered what that left:
> `activities.md` §6.4 still said `End series` sets the series' end to **today**, which
> contradicted decisions 2 and 6, the canonical statements in `today-and-tasks.md` §6.1 and
> `data-model.md` §4.2, and the shipped `endSeriesFromDelete`, which ends on the explicitly
> targeted occurrence and is hidden without one. Only the date was wrong there; ending a
> series is still an ordinary recurrence `PATCH`, as that bullet already said. Separately, no
> canonical product or architecture document cited ADR-053 or
> ADR-054, so three tables restated two accepted decisions with no link back to them. Both are
> closed. The two code divergences found in the same pass are recorded against P2-54 above and
> deliberately not fixed here.

---

### P2-53 — Explicit occurrence detail target and authoritative projection

**Files.** Shared activity-detail schemas/types/client, activity detail and agenda navigation,
the activity read route/service, occurrence repository reads, and their tests.

**What to build.** Introduce a discriminated detail target:

```ts
type ActivityDetailTarget =
  | { kind: 'activity'; activityId: string }
  | { kind: 'occurrence'; activityId: string; date: string };
```

An occurrence-targeted read returns the effective occurrence schedule and resolution after
applying its override. An activity-targeted read returns series state only. Delete
`readOccurrenceDate` and every fallback that chooses an occurrence from cached agenda data.
Navigation from every agenda-projected row, including Today and Plans, carries occurrence
scope. Direct/search navigation to the Activity remains series-only and does not invent a day.

Keep the existing wire-compatible `occurrenceDate` representation where changing it would
invalidate persisted offline mutations. Convert once at each boundary through ADR-053's
helpers.

**Tests.** Warm and cold caches produce the same detail target and values. A series detail
offers no occurrence action. A moved, snoozed, completed and untouched occurrence each returns
its authoritative effective projection.

---

### P2-54 — Atomic recurrence writes and versioned agenda reconciliation

**Files.** Shared inputs/client/OpenAPI, activity and occurrence services/repositories/routes,
mobile mutation defaults and agenda cache/models, and canonical API/data-model rows.

**What to build.** Add one atomic conversion operation that removes recurrence and rewrites
the Activity schedule to the selected occurrence's effective schedule in the same domain
transaction. End series remains a recurrence patch that sets an explicit inclusive date; No
end clears the series-level termination fields. Every write is explicitly activity- or
occurrence-targeted and server-guarded.

Replace “mark stale with no refetch for up to 60 seconds” with versioned reconciliation. A
successful mutation supplies a version/token; the client retains its newer projection and
retries the agenda read with bounded backoff until the returned projection has observed that
version. A stale GSI response may never overwrite newer state. Once a recurrence write is
acknowledged, remove the known-stale prior expansion immediately while reconciliation waits;
do not leave obsolete frequencies interactive. Remove recurrence-specific partial expansion
from `applyPatch`; the server remains the projection authority.

**Tests.** The conversion transaction changes META and its index atomically, preserves the
selected effective schedule, and leaves stored Occurrence history untouched. Inject two stale
agenda responses before a current one and prove neither stale body replaces the projection.
Count and date endings reconcile identically. Component tests distinguish Does not repeat,
No end and End series and prove that each invokes only its named operation.

> **Two obligations handed over by P2-52 — 2026-08-17.** P2-52 is documentation only and does
> not edit code, so it records these rather than fixing them. Both are places where shipped
> code still disagrees with the vocabulary the canonical docs now state, and both belong to
> this task's "each operation invokes only its named operation" deliverable.
>
> 1. **A second, unguarded removal path.** `PATCH /v1/activities/:id` accepts
>    `recurrence: null` and `recurrenceForPatch` returns that `null` straight through
>    (`services/api/src/services/activityService.ts`), removing `recurrence` with no occurrence
>    target and no schedule survivor. That is decision 1's operation performed without decision
>    4's rule, beside the correct `POST /v1/activities/:id/recurrence/convert`. The mobile
>    client no longer uses it — `RepeatSheet.commitDoesNotRepeat` refuses without an occurrence
>    target — so this is an API residue, not a live UI defect. Close it by rejecting the
>    unscoped removal on a recurring Activity the way `complete` and `skip` already reject
>    their unscoped form, and add the `api-contract.md` §2.3 row that says so.
> 2. **One identifier still names two operations.** `apps/mobile/src/features/activity/model/repeat.ts`
>    declares `RepeatOption = 'never' | …` for **Does not repeat** and
>    `RepeatEnds = { kind: 'never' } | …` for **No end**, in the same file. The visible labels
>    are already correct and distinct; the token underneath is not.
>    [`../02-architecture/data-model.md#42-recurrence`](../02-architecture/data-model.md#42-recurrence)
>    §4.2 says these operations "must not share a generic `Never` branch", and ADR-054 names
>    that shared word as the original defect. Rename both to say what each means.

---

### P2-55 — Recurrence E2E matrix and damaged-series audit

**Files.** Web Playwright and iOS Maestro flows, integration fixtures, an operations audit
script/report, and test catalogues.

**What to build.** Exercise the complete user story across real layers: create a daily task;
complete today; verify tomorrow remains live; reschedule one occurrence; edit all future;
convert a selected occurrence to a one-off; create another series; end it; set No end to
restart it; replay one occurrence mutation from the offline queue.

Add an operations-only audit for Activity rows where `recurrence` exists and series status is
`completed` or `skipped`. It reports exact IDs and proposed restoration to `scheduled`; it
does not invent an Occurrence date and does not mutate without an explicit operator command.
Application code still never scans.

**Tests.** Web and iOS flows assert visible behavior, while DynamoDB integration tests assert
the META/OCC/index write sets. The audit is fixture-tested in report-only mode and against an
explicit repair confirmation.

**Operations audit.** Run `pnpm --filter @od/infra audit:recurrence-status` with
`TABLE_NAME` and the normal AWS environment set. The default is report-only JSON: each row
names the exact `activityId`, current terminal status, proposed `scheduled` status, and index
row count. Repair requires both `--repair` and the table-bound confirmation printed by the
refusal message, for example
`--confirm REPAIR_RECURRING_STATUS:od-main-dev`. Each series META row and all of its discovered
ActivityIndex rows are condition-checked and restored in one transaction; no Occurrence row
is created or changed. Repair also clears the invalid series-level `completedAt` and `outcome`
fields, matching the ordinary uncomplete invariant rather than leaving terminal metadata on a
`scheduled` series.

### P2-56 — The resolved outcome on the occurrence and agenda projections

**Files.** `packages/shared/src/types/{activityDetail.ts,agenda.ts}`,
`packages/shared/src/schemas/{activity.ts,agenda.ts}`,
`services/api/src/services/agendaProjection.ts`, the activity read projection,
`apps/mobile/src/features/agenda/components/AgendaRow.tsx`,
`apps/mobile/src/features/activity/components/ActivityDetailScreen.tsx`,
`docs/generated/openapi.json`, and their tests. Inventory is a minimum.

**Why this exists.** Found on 2026-08-15 while fixing a founder report that answering
`Didn't go` on an event still rendered `Attended`. The client half is fixed: `outcomeVerb` now
reads the stored outcome, and the detail screen projects the chosen one optimistically. The
server half is not, and it is the half that survives a reload.

`completionService` stores a declined outcome as `status: 'skipped'` **plus** the outcome, on
the Activity for a one-off and on the `Occurrence` row for a series. Two projections then drop
it:

1. `OccurrenceDetailProjection` carries `nominalDate`, `date`, `time`, `endTime`, `status`,
   `isSnoozed` and `completedAt` — but no `outcome`. So a recurring occurrence resolved as
   `Didn't happen` reads back as an indistinguishable plain skip the moment the server's answer
   replaces the screen's own optimistic one. P2-53's deliverable says this projection carries
   the occurrence's **resolution**; `status` alone is not that.
2. `AgendaItem` has no `outcome` either, so no row can ever render a declined outcome. It shows
   the dimmed `Skipped` tag instead, which is true but is not what the user said.

**Approach.** One optional field on each, both additive
([`../04-conventions/agent-playbook.md`](../04-conventions/agent-playbook.md) §8, so no
`schemaVersion` bump), set from the stored value the services already write:

- `OccurrenceDetailProjection.outcome?: ActivityOutcome` — the occurrence override's own.
- `AgendaItem.outcome?: ActivityOutcome` — the one in force for that row, occurrence override
  first, then the Activity. `AgendaItem` is a trimmed projection and adding to it is a
  deliberate act (playbook §8 step 13); the justification is that the row already renders the
  *positive* verb from `type`, so it is rendering an outcome it cannot see.

Then the two client call sites stop inferring: `AgendaRow`'s trailing slot and its accessible
name pass the row's outcome to `outcomeVerb`, and `ActivityDetailScreen` reads the occurrence's
outcome ahead of the Activity's. Both already accept the argument.

**Size.** M rather than L: no new key, no new access pattern, no new endpoint and no new query —
two optional attributes already stored, carried through two projections that already run.

**Tests.** Repository/service: a declined occurrence round-trips its outcome through the detail
read and through the agenda projection. Route: the field is absent, not `null`, when nothing was
declared. Component: a row and a detail screen each render `Didn't go` for an event and
`Didn't happen` for the other four types, and `Skipped` when there is an outcome-free skip.
Public projection: the field does not reach the invite surface (`security-privacy.md` §4.2).

**Scope guard.** Do not add a status. Do not change what `completionService` writes or which
statuses a declined outcome produces. Do not render an outcome on a row that has none. Do not
add a colour outside P2-40's tables.

---

## Acceptance criteria

1. The three visible phrases Does not repeat, No end and End series cannot invoke the same
   operation.
2. No internal write call represents occurrence scope as optional.
3. No activity or series detail action derives an occurrence date from cached agenda windows.
4. Completing, skipping, snoozing or rescheduling one occurrence never writes series META.
5. Converting a series retains exactly the explicitly selected occurrence as the one-off.
6. End series preserves recurrence history and is inclusive; No end restarts future expansion.
7. A stale agenda-index response never replaces state from a newer acknowledged mutation
   **while the reconciler is still waiting for proof**. Amended 2026-08-18: the wait is
   bounded. When the retry ladder is exhausted without the expected projection version, the
   freshest body is installed and the version expectation is cleared, because the guard's
   purpose is to win a convergence race rather than to withhold data indefinitely. Two
   founder-reported defects were that indefinite case — a new recurring activity kept only its
   anchor-date row with no repeat glyph, and one switched to recurring vanished, both until a
   manual refresh — because moving an index row from the `#S` bucket to `#R` means
   `observedProjectionVersions` stamps no version for it mid-migration, so no proof was ever
   coming.

   **Two expectations are never relaxed by exhaustion.** A pending deletion stays absolute:
   `absent` converges monotonically, is never relaxed, and a deleted activity is never
   resurrected. An activity carrying a **pending recurrence edit** is likewise protected — its
   last canonical expansion is held as an explicitly provisional, inert representation and its
   version expectation stays armed, because installing an unproven body there would reinstate
   the very recurrence the user just changed. Those activities escalate to an authoritative
   targeted read rather than settling for the freshest guess; the freshest-body rule above
   governs every unprotected activity in the same window.
8. The cross-layer recurrence E2E catalogue passes on web and iOS.
9. A recurring occurrence resolved as `Didn't happen` or `Didn't go` reports those words on
   its detail screen and on its agenda row after a cold reload, not `Skipped` and never the
   type's positive verb.
10. `pnpm verify` and recurrence's 100% statement/branch gate pass.

## Out of scope

- Completion-relative recurrence (`mode: 'after_completion'`).
- RFC 5545 custom `rrule` support.
- Multiple occurrences of one series on one wall date.
- Materialising future occurrences.
- Changing persisted offline mutation-variable shapes before their compatibility migration.
- Inventing occurrence history while repairing a damaged series-level status.
