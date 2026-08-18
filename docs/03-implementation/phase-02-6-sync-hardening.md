# Phase 2.6 — Sync hardening

## Goal

Phase 2.6 makes the offline promise the product already wrote true. It is a blocking gate
between the recurrence gate (Phase 2.5) and Phase 3: Phase 3's list-item and Plan-bridge
tasks already specify queued offline creates and a visible `Plan will finish syncing` state
(`phase-03-plans-and-lists.md` P3-13), and building those against today's persistence layer
would build them on writes that can silently disappear.

Three guarantees, deliberately not conflated, each owned by one task:

| | Promise | Task |
| --- | --- | --- |
| 1 | *"I won't lose what I created offline."* | P2-48, P2-49 |
| 2 | *"I can see, trust and cancel what hasn't reached the server."* | P2-48, P2-50 |
| 3 | *"A reminder I set offline will actually remind me."* | P2-57 |

A fourth — *"I can keep working with something that hasn't reached the server"* — is
deliberately **not** in this phase. It is specified as P2-58 and parked.

**Why this is a gate and not a feature.**
[`../01-product/interaction-contract.md`](../01-product/interaction-contract.md#54-offline)
§5.4 has promised a `Pending` row indicator, an offline bar, and optimistically applied
queued writes since Phase 2 began. None of the three exists. Worse, the 2026-08-13 review of
`apps/mobile/src/lib/persister.ts` found queued mutations stored **inside the disposable
query-cache envelope**, where three independent paths destroy them silently:

1. The cache-buster equality check — any cache-schema bump deletes the envelope, queued
   writes included.
2. The seven-day `MAX_AGE` check, which then calls `removeClient()`.
3. The two-second restore deadline — a slow storage read is abandoned, after which the
   persistence subscription saves the **empty** client over the stored one.

Each of these violates guarantee 1 today, before any new offline capability is added.

## The architecture in one paragraph

The client mints the entity's **real, permanent id** (`act_<ULID>`, `rem_<ULID>` —
[`../02-architecture/data-model.md`](../02-architecture/data-model.md#8-ids) §8) before the
request leaves the device, so an offline-created entity is identity-complete from birth and
there is no temporary id, no reconciliation pipeline and no id rewriting. Accepted user
actions are persisted to a **durable intent log** — account-scoped, separately versioned,
never age-expired — *before* the UI reports them accepted; the query cache remains a
disposable projection; TanStack Query remains the execution and retry machinery but stops
being the durability boundary. The server stays the sole authority for `ownerId`,
`createdAt`, versions, capabilities and every derived field. The full contract, including
the four invariants and the durability table, is
[`../02-architecture/tech-stack.md`](../02-architecture/tech-stack.md#34-offline-and-optimistic-updates)
§3.4 mechanism 4, adopted by ADR-055 (which amends ADR-024 — the web mutation queue stays
disabled).

## Founder decisions — 2026-08-13 through 2026-08-17

1. **Client-minted canonical ULIDs, not temporary ids.** §8's own rationale — "no
   coordination needed" — is the property the temp-id design was rebuilding by hand.
2. **Retention is indefinite; automation is bounded.** An intent is never deleted by age.
   After `MAX_AUTOMATIC_INTENT_AGE_DAYS` (30, `packages/shared/src/constants.ts`) it stops
   replaying automatically and moves to `needs_confirmation`, where the user chooses retry
   or discard. Deletion tombstones need to cover only that window, plus no margin borrowed
   from DynamoDB's lazy TTL deletion.
3. **Collision recovery reads; it never re-mints automatically.** On a conditional-create
   collision the client issues an authenticated `GET` for its own id. `200` → its earlier
   write landed; acknowledge on identity and ownership alone — **no field comparison**, the
   server entity wins completely. `404` → ambiguous (foreign collision *or* tombstoned
   create-then-delete): surface for confirmation. Automatic re-minting could bypass a
   tombstone and resurrect a deletion.
4. **The indicators land with the log (P2-48), not with the UI task.** Durable queued
   writes that are invisible are worse than what exists now.
5. **Pending entities are inert but cancellable** (P2-50). A client-minted id is not server
   acceptance; capabilities before acknowledgement are declared per feature, and the default
   is online-only.
6. **Clock uncertainty reduces automation, never extends it.** An intent whose persisted
   timestamp is implausibly in the future, or where clock history indicates rollback, is not
   auto-replayed; it goes to `needs_confirmation`.
7. **iOS only.** ADR-024's web rationale stands: a browser tab is closed, not backgrounded,
   and a queue that never flushes is worse than an error toast.

## Forward constraints

Recorded here so later phases inherit them rather than rediscover them.

- **Phase 3** consumes P2-48's entity-generic pending mechanism for `itm_` and the Plan
  bridge (`Plan will finish syncing` is that mechanism's copy-parameterised indicator, not a
  second system).
- **Phase 5** — a `426` force-upgrade must never destroy a non-empty intent log; the log is
  migrated or drained, and P5-16's push handoff retires local reminder scheduling **for
  server-known entities only**, retaining it for pending local intents with a
  no-double-delivery transition test.
- **Phase 8** — `ai-capture.md` §6.1 already promises offline queueing for Task, Plan and
  ListItem confirmations; they ride the same log.
- **Phase 9** — completion-relative recurrence: an offline completion shows the completion
  and projects **no** next occurrence; the server computes it on sync.
- **Phases 6 and 7** — sharing, invitations, expenses and settlements are online-only by
  nature and stay so.

## Tasks

| ID | Title | Area | Depends on | Parallel-safe | Size |
| --- | --- | --- | --- | --- | --- |
| P2-48 | Account-scoped durable intent log and visible queue state | shared/mobile | P2-33, P2-38, P2-54 | no | L |
| P2-49 | Durable creation: client-minted ids, replay, collision and tombstones | shared/api/mobile | P2-48 | no | L |
| P2-50 | Pending-entity behaviour: inert, explained, cancellable | mobile | P2-49 | yes | M |
| P2-57 | Local reminder projection and cache-driven scheduling | shared/api/mobile | P2-34, P2-49 | yes | L |
| P2-58 | Actions against a pending entity | — | — | **parked** | — |

**4 tasks / 14 AWU** (P2-58 uncounted). Ordering: P2-48 → P2-49 → {P2-50, P2-57}.

---

### P2-48 — Account-scoped durable intent log and visible queue state

**Promise.** Queued user writes survive everything short of the user discarding them, and
the user can always see that they exist.

**Files.** `apps/mobile/src/lib/{persister.ts,intentLog.ts,queryClient.ts,mutationDefaults.ts}`,
`packages/shared/src/constants.ts` (`MAX_AUTOMATIC_INTENT_AGE_DAYS`), the offline bar and
`Pending` indicator components, `docs` amendments listed in the phase preamble. Inventory is
a minimum.

**Approach.**

- **Split the persistence envelope.** The intent log gets its own storage key and its own
  `schemaVersion`; the query cache keeps the buster and `MAX_AGE`. An unsupported log
  version migrates or surfaces — never silently discards. Fix the empty-overwrite restore
  path regardless of the split: it can lose a queued completion today.
- **Write-ahead ordering.** Persist the intent (with its `Idempotency-Key`, minted once),
  then project, then request. The log is the authority on cold start; TanStack's mutation
  cache is rebuilt from it, covering mutations that were mid-flight — not merely paused —
  when the process died.
- **Migrate every existing queued mutation.** All eleven registered activity mutation
  defaults move; a dehydrated paused mutation found in the old envelope is imported once
  and the old copy retired. If only creates moved, every other queued action would keep
  today's data-loss paths.
- **Account-scoped.** The log is namespaced by immutable `userId`; every intent stores its
  `ownerUserId`; hydration and replay filter on the authenticated identity. Sign-out
  quarantines the log rather than destroying it (`auth.md` §3.4); account deletion purges it
  (`security-privacy.md` §3). An intent is never replayed under a different account.
- **Lifecycle.** `queued → in_flight → acknowledged → removed`; transient failure returns to
  `queued`; permanent failure → `failed`, surfaced through §5.4's
  `<n> changes couldn't be applied.` banner, retained until dismissed. Older than
  `MAX_AUTOMATIC_INTENT_AGE_DAYS`, or timestamp implausible / clock rollback detected →
  `needs_confirmation`: no automatic write, an online read-only `GET` may reconcile a
  create, and only an explicit user retry (fresh id, fresh idempotency key) or discard
  resolves it. Cancellation is valid only in `queued`.
- **Visible.** The §5.4 offline bar and the `Pending` row indicator, both entity-generic and
  copy-parameterised so Phase 3's `Plan will finish syncing` and P2-57's reminder copy are
  parameters, not new systems. The 200-intent cap moves here from `MutationCache.onMutate`;
  `failed` and `needs_confirmation` intents count toward it (they hold real user data).
- **FIFO per entity; no cross-entity ordering promise.** Serialize log writes; a storage
  write failure or quota error surfaces before the action is reported accepted.

**Tests.** Kill/relaunch/reconnect replays exactly once; an intent older than seven days
survives; the query buster changes and the cache dies while the log survives; a log
schema-version bump migrates; a >2 s storage restore does not overwrite stored intents; a
mid-flight kill replays; migration imports a legacy paused mutation exactly once; a cancel
racing reconnect either cancels before dispatch or the race loser is a no-op — never a
double write; sign-out then sign-in as another user replays nothing; clock rollback parks
intents in `needs_confirmation`.

**Scope guard.** No web queue (ADR-024 stands). No new server behaviour. No mutations
against pending entities (P2-58). The lifecycle UI beyond bar + indicator + banners is
P2-50.

---

### P2-49 — Durable creation: client-minted ids, replay, collision and tombstones

**Promise.** A create performed offline lands exactly once, survives response loss and
replay after any delay, and can never resurrect an entity deleted elsewhere.

**Files.** `packages/shared/src/schemas/activity.ts`, `docs/generated/openapi.json`,
`services/api/src/{routes/activities.ts,services/activityService.ts,repositories/activityRepository.ts,repositories/keys.ts}`,
`apps/mobile/src/features/agenda/model/applyCreate.ts`,
`apps/mobile/src/lib/{intentLog.ts,agendaCache.ts}`. High-contention: `packages/shared`
schema change lands first per `git-workflow.md` §6.3.

**Approach.**

- `createActivityInput` gains optional `activityId: ulidId('act')`. The server validates
  prefix and encoding, derives ownership from the principal, rejects authority fields as it
  already does (`strictObject`), and creates through a conditional write on
  `attribute_not_exists`, transactionally condition-checked against the deletion tombstone.
- **Tombstone.** Deleting an activity writes `ACT#<activityId>` / `TOMBSTONE` carrying
  `ownerId`, `deletedAt`, and `ttl = deletedAt + MAX_AUTOMATIC_INTENT_AGE_DAYS` — the same
  constant that bounds automatic replay, imported, so the two windows cannot be tuned apart.
  DynamoDB's lazy TTL deletion is extra margin, never counted. `GET` for a tombstoned id
  remains `404`. Account purge removes tombstones with everything else.
- **Collision recovery** per founder decision 3: `GET` own id; `200` acknowledges on
  identity + ownership, server fields win; `404` surfaces
  `This never synced — retry or discard?` — no automatic re-mint.
- **Honest oracle note.** A generic collision error still reveals existence through
  success-versus-failure. IDs are not a security boundary (80 random bits, authorization is
  tenancy); the response carries no owner or entity metadata, and `data-model.md` §8
  documents the bounded residual rather than claiming the copy hides it.
- The client projects the pending entity from local input at mint time (`applyCreate`'s
  second entry point) and reconciles server-owned fields from the `201`.

**Tests.** Replay >25 h after a committed-but-lost response acknowledges via `GET` without a
duplicate; create → delete on another device → replay after tombstone → surfaced, not
resurrected; create → delete after TTL-expiry of the tombstone cannot occur inside the
automation window (property: `deletedAt + N ≥ intentCreatedAt + N`); collision with a
foreign id surfaces confirmation; a client-supplied malformed id is `validation_failed`; the
201-reconciliation preserves the client id and adopts server `createdAt`/`updatedAt`;
`needs_confirmation` retry uses a fresh id and key.

**Scope guard.** No client-supplied `ownerId`/`createdAt`. No change to `gsi1sk` shapes —
chronology stays timestamp-led. No list-item or reminder creation here (P2-57, Phase 3).

---

### P2-50 — Pending-entity behaviour: inert, explained, cancellable

**Promise.** A pending entity can be kept or discarded, and everything it cannot yet do says
why.

**Files.** `apps/mobile/src/features/activity/components/ActivityDetailScreen.tsx`, agenda
row/swipe surfaces, `apps/mobile/src/lib/intentLog.ts` selectors. Pending-ness is derived
from the log — no field is added to shared DTO schemas.

**Approach.** Server-directed actions (complete, reschedule, edit, share, expense) are
absent-or-disabled-with-words on a row whose `CREATE` is unacknowledged; the detail screen
explains: `Waiting to sync — you can cancel it, and everything else unlocks once it's
synced.` Cancel is offered in `queued` only, removes intent + projection, sends nothing.
A reminder attached to a pending activity states it is not armed until sync (until P2-57
lands, and its copy then changes to the armed-locally wording). `needs_confirmation` and
`failed` intents render their §5.4 banners from here.

**Tests.** No completion/reschedule/edit affordance on a pending row (capability probe, not
style probe); cancel in `queued` issues no request and clears row + intent; an `in_flight`
entity offers no cancel; acknowledgement flips the row to normal without remount; the
explanation copy is announced to a screen reader, not colour-only.

**Scope guard.** No mutations against pending entities. No new endpoints.

---

### P2-57 — Local reminder projection and cache-driven scheduling

**Promise.** A reminder created offline fires on time with no connectivity; a reminder
changed while online and foregrounded re-arms without backgrounding the app.

**Files.** `packages/shared/src/schemas/reminder.ts` (optional client `reminderId`),
`docs/generated/openapi.json`, the reminder create path in
`services/api/src/services/activityService.ts`,
`apps/mobile/src/features/reminders/{localSchedule.ts,projection.ts}`,
`apps/mobile/src/lib/push.ts` untouched (it is already declarative).

**Approach.** Replace `refreshLocalNotifications`' network reads with a bounded persisted
projection (today → +7 days, reminder-relevant fields only). **Hybrid rule:** server-known
activities come solely from the server's `include=reminders` responses — never re-expanded
locally (Phase 2.5's authoritative projection is the source of truth for occurrence state);
pending local activities are expanded with `expandRecurrence`, safe precisely because no
server overrides can exist for them. Any reminder-relevant change — including intent
acknowledgement — marks the schedule dirty and triggers recompute-and-replace; a failed
recompute leaves the existing scheduled set intact. **iOS caps pending local notifications
at 64**, a constraint no earlier document recorded: arm **nearest-first, capped with
headroom (≈60)**, and treat the fire time of the last armed request as the device's
`scheduledThrough` horizon — a heavy user gets a shorter local horizon, never lost
reminders. Quiet-hours evaluation imports the shared pure policy module from
`packages/shared` (`notifications.md` §4) rather than restating the rules. This task builds
the arming and verification half of the Phase 5 handoff: after `replaceLocalNotifications`,
re-read the scheduled set and verify it matches intent — that verification is what P5-16's
acknowledgement will assert, and until Phase 5 exists it simply gates marking the schedule
clean. All-or-nothing: a partial arming stays dirty and retries. Client-minted `rem_` reuses P2-49's
server semantics; **this task must not modify P2-48's log — needing to means the primitive
was activity-specific, and that is the acceptance test for Phase 3's reuse too.**

**Tests.** Offline-created reminder fires (fixture clock); skipped-occurrence reminder does
not; foregrounded online change re-arms; failed refresh cancels nothing; server-known series
are never locally expanded; acknowledgement re-keys the notification set with no orphan and
no double.

**Scope guard.** No notification actions (Phase 9). No projection past eight days. The push
handoff is P5-16's, amended to retire local scheduling for server-known entities only.

---

### P2-58 — Actions against a pending entity — **parked**

Recorded so the inert boundary is a decision. Client-minted ids already removed id
rewriting; what remains is ordered replay behind the create, initial `If-Match` taken from
the `CREATE` response, and failing dependents with their create under one banner. Adopting
it amends §5.4's inert paragraph. Not scheduled, not counted.

---

## Acceptance criteria

1. Airplane mode → create task with reminder → kill app → relaunch offline → row shows
   `Pending`, reminder shows its armed/not-armed state truthfully → reconnect → exactly one
   server entity, `Pending` clears, no user action required.
2. The three persister data-loss paths (buster, age, slow-restore overwrite) are gone, each
   proven by the P2-48 test that reproduces it against the old behaviour.
3. A create whose response was lost is acknowledged by read-recovery after 25+ hours with no
   duplicate; a create deleted from another device is never resurrected by replay.
4. An intent older than 30 days performs no automatic write and is resolved only by explicit
   retry or discard; clock rollback parks intents the same way.
5. Sign-out and sign-in as a different account replays nothing across the boundary; account
   deletion purges the log and tombstones.
6. A pending entity offers exactly {open, cancel}; every refused action states why in words.
7. An offline-created reminder fires on a device with no connectivity (P2-57), and P5-16's
   later handoff test shows no double delivery.
8. `pnpm verify` green; OpenAPI regenerated and committed; every doc named in the preamble
   amended in the same PRs that change the behaviour it describes.
