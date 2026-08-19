# Phase 2.6 — Sync hardening

## Goal

Phase 2.6 makes the offline promise the product already wrote true. It is a blocking gate
between the recurrence gate (Phase 2.5) and Phase 3: Phase 3's list-item and Plan-bridge
tasks already specify queued offline creates and a visible `Plan will finish syncing` state
(`phase-03-plans-and-lists.md` P3-13), and building those against today's persistence layer
would build them on writes that can silently disappear.

The original five guarantees remain acceptance requirements. P2-60 recorded the fifth after
device testing, but its read-time materializer is historical evidence rather than production
architecture:

| | Promise | Task |
| --- | --- | --- |
| 1 | *"I won't lose what I created offline."* | P2-48, P2-49 |
| 2 | *"I can see, trust and cancel what hasn't reached the server."* | P2-48, P2-50 |
| 3 | *"A reminder I set offline will actually remind me."* | P2-57 |
| 4 | *"Undo and retry follow what was durably accepted, not whether one HTTP promise resolved."* | P2-59 |
| 5 | *"Reconnect and refresh never erase an accepted local action while it is still unresolved."* | P2-60 evidence; P2-61…P2-63 production replacement |

A sixth — *"I can keep working with something that hasn't reached the server"* — is
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

## Architecture — amended 2026-08-18 by ADR-057

After a native feature migrates, **typed SQLite repositories are the sole source of its
visible domain state**. A locally accepted offline-capable action is one SQLite transaction:
append the durable outbox intent, materialize the affected visible typed rows, and commit
before the coordinator reports acceptance. Append or transaction failure is the only
coordinator result named `refused`. Reads are ordinary indexed repository queries; they do
not fold TanStack responses and intents, and connectivity never clears or reconstructs rows.
One serialized sync engine pushes and reconciles through existing API endpoints, installing
canonical responses and retiring or parking intents transactionally. TanStack may remain
transport machinery, but it is neither native domain state nor native persistence.

The client still mints the entity's **real, permanent id** (`act_<ULID>`, `rem_<ULID>` —
[`../02-architecture/data-model.md`](../02-architecture/data-model.md#8-ids) §8), and
DynamoDB/API remain authoritative for ownership, versions, capabilities, derived fields,
occurrence history and server recurrence semantics. SQLite uses domain-specific tables and
indexed columns, not DynamoDB keys and not a generic `base_json`/`view_json` entity table.
ADR-057 amends ADR-024/055/056 for migrated native domains; web retains the online-first
TanStack adapter and no durable mutation queue.

### P2-60 historical evidence — superseded, uncounted

P2-60 was specified in `bc75375` after real-device testing exposed reconnect/refetch
regressions. It modeled visible state at read time as `server base ⊕ unresolved intents` and
produced a 637-line `durableOverlay.ts` experiment plus transition tests in commits `53ea4ea`
and `fe70f5d`. The design evidence remains; those runtime commits do **not** land in the
production lineage. The experiment
proved the required invariants — no visual replay, no stale-refetch regression, identical
state after restart, no disagreement between screens, and no empty Today during a failed
refresh — while also proving that combining two authorities on every read remained glitchy
during offline/online transitions. P2-61…P2-63 preserve the invariants and replace the
materializer with write-time SQLite transactions. P2-60 is historical and uncounted in
roadmap totals.

## Founder decisions — 2026-08-13 through 2026-08-17

1. **Client-minted canonical ULIDs, not temporary ids.** §8's own rationale — "no
   coordination needed" — is the property the temp-id design was rebuilding by hand.
2. **Retention is indefinite; automation is bounded.** An intent is never deleted by age.
   After `MAX_AUTOMATIC_INTENT_AGE_DAYS` (30, `packages/shared/src/constants.ts`) it stops
   replaying automatically and moves to `needs_attention/parked`, where the user chooses retry
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
   auto-replayed; it goes to `needs_attention/parked`.
7. **iOS only.** ADR-024's web rationale stands: a browser tab is closed, not backgrounded,
   and a queue that never flushes is worse than an error toast.

## Forward constraints

Recorded here so later phases inherit them rather than rediscover them.

- **Phase 3** consumes P2-48's entity-generic pending mechanism for `itm_` and the Plan
  bridge through the same SQLite transaction/outbox contract. Its Lists/ListItems use typed
  repositories, not a second cache projection.
- **Phase 5** — a `426` force-upgrade must never destroy a non-empty SQLite outbox; its schema
  is migrated or drained, and P5-16's push handoff retires local reminder scheduling **for
  server-known entities only**, retaining it for pending local intents with a
  no-double-delivery transition test.
- **Phase 8** — confirmed Task, Plan and ListItem actions use the same coordinator and
  transactional outbox; capture requests themselves remain online-only.
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
| P2-59 | Durable action coordinator, dependent intents and replay liveness | mobile/docs | P2-48, P2-49 | no | L |
| P2-60 | Read-time durable overlay experiment | — | P2-59 | **historical, superseded, uncounted** | — |
| P2-61 | ADR-057 and SQLite native-state foundation | mobile/docs | P2-59 | no | L |
| P2-62 | Transactional outbox and Activity/Agenda vertical slice | shared/mobile | P2-61 | no | L |
| P2-63 | Sync convergence and legacy retirement | shared/mobile | P2-62 | no | L |

**8 live tasks / 30 AWU** (P2-58 parked and P2-60 historical, both uncounted). Ordering:
P2-48 → P2-49 → {P2-50, P2-57} → P2-59 → P2-61 → P2-62 → P2-63. The
SQLite migration tasks are serial because each establishes the invariant used by the next.

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
  then project, then request. A create surface may dismiss after the first two steps; it does
  not wait for connectivity or the response. The log is the authority on cold start;
  TanStack's mutation cache is rebuilt from it, covering mutations that were mid-flight —
  not merely paused — when the process died.
- **Migrate every existing queued mutation.** All eleven registered activity mutation
  defaults move; a dehydrated paused mutation found in the old envelope is imported once
  and the old copy retired. If only creates moved, every other queued action would keep
  today's data-loss paths.
- **One replay owner.** Hydrate the log and import/retire legacy paused mutations before
  installing connectivity or accepting writes. The intent-log session alone requests iOS
  replay. Overlapping startup/reconnect requests coalesce into one serial drain; an atomic
  claim returns no intent without changing storage when another pass already owns it.
- **Account-scoped.** The log is namespaced by immutable `userId`; every intent stores its
  `ownerUserId`; hydration and replay filter on the authenticated identity. Sign-out
  quarantines the log rather than destroying it (`auth.md` §3.4); account deletion purges it
  (`security-privacy.md` §3). An intent is never replayed under a different account.
- **Lifecycle.** `queued → in_flight → acknowledged → removed`; transient failure returns to
  `queued`; permanent failure → `failed`, surfaced through §5.4's
  `<n> changes couldn't be applied.` banner, retained until dismissed. Older than
  `MAX_AUTOMATIC_INTENT_AGE_DAYS`, or timestamp implausible / clock rollback detected →
  `needs_attention/parked`: no automatic write, an online read-only `GET` may reconcile a
  create, and only an explicit user retry (fresh id, fresh idempotency key) or discard
  resolves it. Cancellation is valid only in `queued`.
- **Visible.** The §5.4 offline bar and the `Pending` row indicator, both entity-generic and
  copy-parameterised so Phase 3's `Plan will finish syncing` and P2-57's reminder copy are
  parameters, not new systems. The 200-intent cap moves here from `MutationCache.onMutate`;
  `needs_attention` intents count toward it (they hold real user data).
- **FIFO per entity; no cross-entity ordering promise.** Serialize log writes; a storage
  write failure or quota error surfaces before the action is reported accepted.

**Tests.** Kill/relaunch/reconnect replays exactly once; an intent older than seven days
survives; the query buster changes and the cache dies while the log survives; a log
schema-version bump migrates; a >2 s storage restore does not overwrite stored intents; a
mid-flight kill replays; migration imports and retires a legacy paused mutation exactly once;
two concurrent replay requests dispatch one intent once and cannot overtake the next FIFO
intent; a failed claim leaves its stored intent byte-for-byte unchanged; a reconnect requested
during a transient failure is coalesced and reruns; a cancel racing reconnect either cancels
before dispatch or the race loser is a no-op — never a double write; sign-out then sign-in as
another user replays nothing; clock rollback parks intents in `needs_attention/parked`.

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
  second entry point) and reconciles server-owned fields from the `201`. A recurring create
  expands immediately across every currently cached agenda window with the shared recurrence
  engine; cold-start restoration rebuilds the same projection from the intent log. These are
  query-cache rows only, never materialized Occurrence storage. The exception is limited to
  an unacknowledged create, whose full first segment came from this client; recurrence edits
  and every server-known series remain server-expanded.
- If an offline device has no cached Today response yet, a pending create that belongs in the
  Today/tomorrow window seeds a minimal stale window rather than showing the no-data load
  failure. Opening that pending row reconstructs detail from the durable create intent and
  sends no `GET` for an entity the server cannot know yet.

**Tests.** Replay >25 h after a committed-but-lost response acknowledges via `GET` without a
duplicate; create → delete on another device → replay after tombstone → surfaced, not
resurrected; create → delete after TTL-expiry of the tombstone cannot occur inside the
automation window (property: `deletedAt + N ≥ intentCreatedAt + N`); collision with a
foreign id surfaces confirmation; a client-supplied malformed id is `validation_failed`; the
201-reconciliation preserves the client id and adopts server `createdAt`/`updatedAt`;
`needs_attention/parked` retry uses a fresh id and key.
The mobile projection test also proves persist → full cached-window recurrence expansion →
request, and that the `201` atomically replaces the provisional rows without changing id.

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
lands, and its copy then changes to the armed-locally wording). Structured
`needs_attention` intents render their §5.4 banners from here.

**Tests.** No completion/reschedule/edit affordance on a pending row (capability probe, not
style probe); cancel in `queued` issues no request and clears row + intent; an `in_flight`
entity offers no cancel; acknowledgement flips the row to normal without remount; the
explanation copy is announced to a screen reader, not colour-only.

**Scope guard.** No mutations against pending entities. No new endpoints.

---

### P2-57 — Local reminder projection and cache-driven scheduling

> **Native source amended by ADR-057.** This heading and implementation plan record the
> original task. After P2-62, reminders derive from committed typed local rows; they do not
> read a TanStack cache or maintain an independent domain projection. The arming horizon,
> iOS cap, quiet-hours policy and Phase 5 handoff requirements remain unchanged.

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

### P2-59 — Durable action coordinator, dependent intents and replay liveness

**Promise.** The durable mutation layer — not an HTTP promise — decides whether an
offline-capable action was refused, queued, in flight, acknowledged, or needs attention;
Undo remains safe across transient failure, response loss, races and process death.

**Files.** `apps/mobile/src/lib/{intentLog.ts,intentReplay.ts,intentLogSession.ts,
queryClient.ts,startUndoable.ts,durableAction.ts}`, their focused tests, the existing
activity/agenda undo call sites, and ADR-056 plus the Phase 2.6 architecture/product
amendments. Inventory is a minimum. This task must preserve P2-54/P2-55's occurrence
targeting and the durable recurring-series reconciliation that lands immediately before it.

**Approach.**

- **Intent schema v2.** `refused` is coordinator-only and never stored. Persist only
  `queued | in_flight | acknowledged | needs_attention`. `needs_attention` carries
  structured `rejected` (permanent HTTP status/code/details when available) or `parked`
  (`clock_uncertainty`, `replay_age_expired`, `ambiguous_collision`, `legacy_unknown`).
  `lastError` remains display/diagnostic text and is never parsed for control flow.
- **Migration and identity.** v1 `failed` migrates to
  `needs_attention/rejected`; `needs_confirmation` migrates to
  `needs_attention/parked/legacy_unknown` unless a structured cause can be proved. Every
  distinct write survives. Identical duplicate appends for one stable id coalesce;
  conflicting payload reuse surfaces an invariant/corruption failure. Legacy duplicate ids
  are disambiguated deterministically without losing distinct writes. PATCH/delete
  settlement uses a stable id minted once, never a newly evaluated `Date.now()`.
- **Dependencies and receipts.** An inverse is a durable dependent ordered after its
  original. A dependency in `queued`, `in_flight` or `needs_attention` blocks dispatch;
  `acknowledged` permits it. Acknowledged parents retain lightweight receipts while a
  dependent needs the outcome and compact only afterward. Missing dependencies block unless
  a schema invariant proves acknowledgement. Cancel/discard atomically retires compensation
  dependents. A lost response is recovered authoritatively before the inverse is retired or
  executed.
- **Observable coordinator.** `DurableAction` reports
  `refused | queued | in_flight | acknowledged | needs_attention` and exposes
  `undo(): Promise<DurableAction>`. Queued Undo atomically cancels the original and reverts
  projection. In-flight/acknowledged Undo appends the inverse durably. Permanent rejection
  rolls back and retires an unnecessary inverse; ambiguity preserves both until recovery.
  `startUndoable` becomes presentation-only and does not translate a transient request
  rejection into action failure.
- **Replay barrier and liveness.** Replay initially remains globally serial, but selection
  enforces a real per-entity barrier: if N requeues or needs attention, N+1 for that entity
  does not dispatch; unrelated entities may progress. Replay is level-triggered,
  single-flight and bounded/coalesced on enqueue, transient backoff, foreground and
  reconnect, without requiring a false→true connectivity edge or installing a fixed loop.
- **Measured reachability.** Do not change the local probe policy merely because agenda
  reconciliation is slow. Instrument or reproduce the five-second health timeout first;
  probe decoupling is a separate measured change. TanStack remains cache/request execution
  machinery, never the semantic authority for durable acceptance.

**Tests.** (1) append failure returns `refused`, sends nothing and rolls back; (2) transient
offline completion remains projected and reports `queued`; (3) queued Undo atomically
cancels and never replays; (4) Undo racing claim produces cancel-before-claim or one durable
inverse-after-claim; (5) process death after in-flight Undo preserves the inverse; (6)
permanent rejection becomes structured `needs_attention/rejected` and rolls back/surfaces;
(7) age/clock/collision becomes `needs_attention/parked` and does not replay; (8) identical
duplicate append creates one intent while conflicting reuse surfaces safely; (9) v1→v2
migration preserves distinct writes and explicitly handles duplicate legacy ids; (10)
same-entity N+1 does not dispatch behind requeue/attention while another entity may progress;
(11) enqueue/foreground/reconnect/backoff triggers coalesce and eventually drain without a
connectivity edge; (12) recurring create, ordinary create, completion detail projection,
recurring-series reconciliation and existing replay suites remain green.

**Scope guard.** No web queue. No cross-entity concurrency requirement. No server recurrence
change, pending-entity mutation expansion, CRDT/local replica, or probe-policy change without
measured evidence. No parsing `lastError` for behavior.

---

### P2-61 — ADR-057 and SQLite native-state foundation

**Promise.** Native domain screens can subscribe to one account-scoped, transactional,
versioned SQLite state layer without changing broad feature behavior yet.

**Files.** `apps/mobile/package.json`, Expo app config, `apps/mobile/src/lib/sqlite/{database,
accountDatabase,migrations,transaction,subscriptions,legacyImporter}.ts`, typed repository
interfaces and test fixtures under `apps/mobile/src/repositories/`, shared repository/use-case
interfaces where native and web adapters meet, plus ADR-057 and the architecture/security/auth
documents named in this phase. Inventory is a minimum; feature hooks do not cut over here.

**Approach.**

- Install and configure the Expo SDK-compatible `expo-sqlite`. Open one database per
  immutable account namespace using a hashed filename, and assert the unhashed owner identity
  in metadata before any read or replay. Enable WAL and foreign keys on every open.
- Add monotonic, transactional schema migrations; a serialized transaction abstraction; and
  typed repository/query/subscription foundations. Domain tables use explicit/indexed columns
  for every filter, render and order field. Nested opaque fields may be JSON. A verified
  server snapshot/version may be retained for rollback/rebase, but there is no generic
  entity table and no frozen `base_json`/`view_json` schema.
- Define account lifecycle before data: sign-out closes and quarantines the current DB;
  another account opens another filename; confirmed account deletion purges only that
  account's DB. Never age-delete a DB with unresolved outbox work.
- Build an idempotent legacy-import harness. It accepts only verified server-base cache data
  plus every distinct intent/status/dependency, imports them in one transaction, reads back
  and verifies counts/identities/dependencies, writes a migration receipt, then permits
  retirement. A P2-60 materialized overlay is never imported as canonical base. Ambiguous
  cache provenance retains intents and requires sync rather than guessing.
- Keep shared repository/use-case interfaces platform-neutral: native will bind SQLite; web
  keeps the existing online-first TanStack adapter.

**Tests.** WAL and foreign keys are enabled; migrations are ordered, transactional,
idempotent and roll back on failure; concurrent callers serialize; typed subscriptions
publish only after commit; owner metadata rejects a mismatched account; account A close then
account B open exposes no A row or intent; confirmed deletion purges only the named DB; an
unresolved-outbox DB is not age-deleted; importer rerun is a receipt-backed no-op; malformed
or partial import rolls back; ambiguous cache imports all distinct intents but no guessed
base; P2-60 overlay-shaped cache data is rejected as canonical base.

**Scope guard.** Foundation only: no broad screen or feature cutover, sync engine, endpoint
change, generic entity table, DynamoDB PK/SK/GSI mirror, ORM requirement, CRDT, generic
local-first framework, SQLite-backed web adapter or database cleanup by age.

---

### P2-62 — Transactional outbox and Activity/Agenda vertical slice

**Promise.** Activity and Agenda visible native state changes once, at local commit, and
remains identical across reconnect, refresh, process death and every screen until a later
transaction installs canonical truth.

**Files.** `apps/mobile/src/lib/sqlite/{outbox,activityRepository,agendaRepository,
activityTransactions}.ts`, the serialized action coordinator and sync-engine interfaces,
Activity/Agenda hooks/screens/use cases, recurrence coverage/materialization helpers, legacy
P2-59 adapters, and focused repository/coordinator/real-device transition suites. Inventory
is a minimum.

**Approach.**

- Port P2-59 semantics into the SQLite outbox: stable mutation ids; idempotent equivalent
  append; structured `needs_attention/rejected|parked`; durable dependent inverse intents;
  explicit `ordering_key`; per-key barriers; receipts while dependency or reconciliation
  needs them; and bounded, level-triggered replay. Append/transaction failure is the only
  coordinator-only `refused` and sends no request.
- Before a newly opened account session can schedule replay, transactionally requeue claims
  left `in_flight` by the previous process without changing their identity, sequence,
  attempts, dependency/compensation edges, payload or local projection. A live session is
  initialized once, so its active request cannot be recovered out from under it.
- Make each accepted offline-capable Activity action one transaction: append intent, update
  every affected Activity/Agenda materialized row, then commit. Materialization occurs only
  in local-action and sync transactions, never in reads. Completion, rapid toggle, Undo,
  create, reschedule and one-occurrence edit use ordinary typed repository queries after
  commit.
- Recurring CREATE may expand across known local coverage. A one-occurrence edit may update
  its explicit row. An existing-series recurrence edit retains prior canonical agenda rows
  with queued/updating state; it does not locally invent the new server expansion.
- Cut Activity/Agenda native hooks and screens to typed SQLite repositories/subscriptions.
  They never combine TanStack results and outbox intents at render time. Remove native
  Activity/Agenda domain authority from TanStack; it may still execute HTTP behind the sync
  adapter.
- Reminders become a derived consumer of committed local rows. Completion-relative
  recurrence remains server-reconciled and projects no locally invented next occurrence.
- Canonical installation is mutation-aware: occurrence writes consume the returned
  occurrence and update only that occurrence's detail/Agenda rows, while a later same-key
  intent blocks an older response. Unresolved Activity/reminder deletes suppress stale pull
  resurrection; authoritative reminder coverage prunes only covered canonical reminders and
  preserves unresolved local creates.

**Tests.** Unit/integration tests cover transactional refusal, commit-before-publish,
completion, rapid complete/uncomplete, queued cancellation, durable Undo after claim,
offline one-off and recurring create, reschedule, one-occurrence edit, existing-series
queued/updating retention, restart-mid-claim recovery, canonical occurrence
acknowledgement, deletion/reminder pull suppression and scoped reminder pruning. Real-device
transition acceptance proves: rapid offline/online flapping during completion never reverses the row;
kill after local commit before request restores identical state; a stale response arriving
last cannot regress visible rows; complete/Undo racing reconnect produces one correct final
state; offline/manual refresh retains Today; recurring create offline remains expanded; and
multiple same-`ordering_key` intents preserve order while unrelated work may progress.

**Scope guard.** Activity/Agenda native vertical slice only. No broad Lists/ListItems or AI
cutover, cross-entity concurrency requirement, generic change feed, generic entity table,
DynamoDB mirror, ORM, CRDT, web queue or local expansion of an existing server-known series.

---

### P2-63 — Sync convergence and legacy retirement

**Promise.** The Activity/Agenda slice converges through existing server contracts, safely
retires legacy native persistence only after verified import, and makes refresh a non-
destructive sync request.

**Files.** `apps/mobile/src/lib/sync/{engine,pushAdapter,pullAdapter,coverage,
reconciliation}.ts`, SQLite repositories/migrations/import receipts, existing shared endpoint
clients, Activity/Agenda refresh/error surfaces, removal of native query-domain persistence
paths in `persister.ts`/query hooks, and transition/targeted-reconciliation/account-isolation
tests. Inventory is a minimum.

**Approach.**

- One serialized native sync engine owns all network writes and reconciliation. It claims
  eligible intents, observes explicit `ordering_key` domains, calls existing API endpoints,
  installs canonical write responses, rematerializes affected rows, and retires or parks
  intents transactionally. Unrelated keys may progress behind a blocked key; parallel
  dispatch is not required.
- Connectivity, foreground and manual refresh only schedule bounded level-triggered work.
  Pull-to-refresh calls `syncNow()`; failure retains committed rows and records a retryable
  sync error with Retry. Connectivity never clears, reconstructs or directly edits visible
  domain rows.
- Converge through existing collection/detail endpoints, coverage-aware foreground/manual
  pulls, canonical write responses, stale-version guards, tombstones/deletions and the
  existing targeted strong activity-agenda read. Do not make a generic change-feed/cursor a
  prerequisite; keep the sync interfaces extensible for Phase 6 collaboration.
- After an existing-series recurrence PATCH acknowledgement, the targeted strong read
  atomically replaces that activity's agenda rows, including authoritative zero rows. A
  failed targeted read retains prior rows with retryable state and exposes Retry.
- Run the P2-61 importer, verify read-back and receipt, then retire legacy AsyncStorage intent
  data and native persisted query-domain paths. Never import a P2-60 overlay as server base.
  Phase 3 begins only after this retirement/convergence gate passes.

**Tests.** Existing endpoint push/pull adapters, coverage gaps, tombstones, deletions,
stale-version rejection and canonical-response install are exercised against fixtures.
Real-device acceptance repeats every P2-62 transition and adds: recurrence edit retains rows
until the strong canonical replacement; authoritative zero rows clear only that activity;
failed targeted read retains rows and exposes Retry; migration failure leaves legacy data
intact; verified receipt precedes retirement; and account switching cannot expose rows or
claim/replay another database's outbox.

**Scope guard.** No new server change-feed/cursor, server conflict protocol, CRDT, generic
local-first framework, generic entity table, DynamoDB mirror, ORM, cross-entity concurrency,
SQLite web dependency or new recurrence authority. Phase 6 may add a durable change feed and
conflict policy only when shared offline edits require them.

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
9. Durable append refusal sends no request and rolls projection back; transient network
   failure keeps the accepted projection queued, and permanent rejection is structured
   `needs_attention/rejected` rather than inferred from display text.
10. Undo cancellation/inverse races are atomic and crash-safe: a queued original never
    replays after cancellation, while an in-flight or acknowledged original has exactly one
    durable dependent inverse whose dependency is resolved authoritatively.
11. Intent-log v1→v2 migration preserves every distinct write, handles duplicate ids
    deterministically, and new duplicate appends are idempotent only for equivalent payloads.
12. Replay cannot overtake a blocked earlier intent for one entity; coalesced enqueue,
    backoff, foreground and reconnect triggers eventually drain eligible work without a
    fixed polling loop or a required offline→online edge.
13. P2-60's regression requirements hold without a read-time overlay: no visual replay, no
    stale-refetch regression, identical state after restart, no screen disagreement and no
    empty Today during failed refresh.
14. Rapid offline/online flapping during completion causes no reversal; killing after local
    commit but before request restores identical state; and a stale response arriving last
    cannot regress committed rows.
15. Complete/Undo racing reconnect produces one correct final state; same-`ordering_key`
    intents preserve order while unrelated keys may progress.
16. Manual refresh while offline retains Today and records a retryable sync error; recurring
    create remains expanded across known local coverage.
17. Existing-series recurrence edit retains prior rows with queued/updating state until the
    targeted strong read atomically replaces that activity's rows, including zero rows;
    failed replacement retains rows and exposes Retry.
18. One hashed SQLite database per asserted immutable account namespace prevents another
    account from reading or replaying its rows; confirmed deletion purges the named DB, and
    no unresolved-outbox DB is age-deleted.
19. Legacy import is transactional, receipt-backed and idempotent; it preserves verified
    base plus every distinct intent/status/dependency, never treats a P2-60 overlay as base,
    and retires AsyncStorage data only after read-back verification.
20. Phase 3 does not begin until native Activity/Agenda domain reads and persistence no
    longer depend on TanStack/AsyncStorage and P2-63's real-device gate passes.
