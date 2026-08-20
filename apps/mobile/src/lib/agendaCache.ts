import { getActivityAgenda, getAgenda } from '@od/shared/client';
import { addWallDays } from '@od/shared/recurrence';
import type { AgendaQuery, CreateActivityInput } from '@od/shared/schemas';
import { type Instant, toWallDate, toWallTime } from '@od/shared/time';
import type {
  Activity,
  ActivityAgendaData,
  ActivityDetail,
  ActivityOutcome,
  AgendaData,
  AgendaItemStatus,
} from '@od/shared/types';
import type { MutationKey, QueryClient } from '@tanstack/react-query';
import { agendaKey, TODAY_AGENDA_INCLUDE } from '@/features/agenda/keys';
import {
  type AgendaMutationTarget,
  type AgendaProjectionClock,
  applyCompletion,
  findAgendaItem,
  projectDay,
  replaceAgendaItem,
  uniqueItems,
} from '@/features/agenda/model/applyCompletion';
import { applyCreate, applyPendingCreate } from '@/features/agenda/model/applyCreate';
import { applyDelete } from '@/features/agenda/model/applyDelete';
import { applyPatch } from '@/features/agenda/model/applyPatch';
import { applyReschedule } from '@/features/agenda/model/applyReschedule';
import { applySkip } from '@/features/agenda/model/applySkip';
import { applySnooze } from '@/features/agenda/model/applySnooze';
import { resolveAgendaTimezone } from '@/features/agenda/timezone';
import { apiClient } from '@/lib/apiClient';
import { getActiveIntentLog } from '@/lib/intentReplay';
import { type ActivityMutationTag, activityMutationKeys } from '@/lib/mutationKeys';
import { activityDetailKey, activityKey } from '@/lib/queryKeys';

const AGENDA_KEY = ['agenda'] as const;
/**
 * Widened 2026-08-18. The old ladder gave up after ~6.5 s, which a cold local table's GSI
 * convergence can exceed — and giving up used to be permanent (see the exhaustion branch in
 * `reconcileAgendaProjection`). Most occurrences now resolve properly rather than through the
 * fallback.
 */
const RECONCILE_DELAYS_MS = [0, 150, 400, 900, 1_800, 3_200, 5_000] as const;
/**
 * What a window is still waiting to see before it will accept a body from the index.
 *
 * - `version` — a write happened; the body must prove the index has observed it.
 * - `absent` — the Activity was **deleted**; the body must no longer contain it at all.
 *
 * The second exists because a deletion has no version to wait for: the row it would have been
 * stamped on is gone, so "has the index caught up" can only be asked as "is it still there".
 */
type PendingExpectation =
  | { readonly kind: 'version'; readonly version: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'protected'; readonly version?: string };

const pendingByClient = new WeakMap<
  QueryClient,
  Map<string, Map<string, PendingExpectation>>
>();

type AgendaQueryKey = readonly [
  'agenda',
  AgendaQuery['from'],
  AgendaQuery['to'],
  AgendaQuery['tz'],
  AgendaQuery['include'] | null,
];

function keyId(key: readonly unknown[]): string {
  return JSON.stringify(key);
}

function observed(data: AgendaData, activityId: string, version: string): boolean {
  return (
    data.projectionVersions?.some(
      (entry) => entry.activityId === activityId && entry.version >= version,
    ) === true
  );
}

/** Whether a body still carries any row for this Activity, on any day of the window. */
function contains(data: AgendaData, activityId: string): boolean {
  return data.days.some((day) =>
    [...day.schedule, ...day.anytime, ...day.earlier].some(
      (item) => item.activityId === activityId,
    ),
  );
}

/**
 * **A delete arms the guard; it does not disarm it.**
 *
 * This used to clear the Activity's pending entry, on the reasoning that a deleted row can
 * never emit the projection version an older reconciliation is waiting for. True, and it left
 * the window with nothing to reject a stale body *with* — so the next read that still carried
 * the deleted Activity was accepted, and the row came back. Tapping it then `404`s into
 * "Couldn't load this", which is the worst version of this: not stale data, deleted data,
 * leading to a dead end.
 *
 * Replacing the version expectation with `absent` keeps the same machinery and inverts the
 * question. It converges monotonically — a deleted Activity never returns — so the first body
 * without it clears the entry, which in the ordinary case is the very next read.
 */
function expectAbsent(client: QueryClient, activityId: string): void {
  let windows = pendingByClient.get(client);
  if (windows === undefined) {
    windows = new Map();
    pendingByClient.set(client, windows);
  }
  for (const [key] of client.getQueriesData<AgendaData>({ queryKey: AGENDA_KEY })) {
    const id = keyId(key);
    const pending = windows.get(id) ?? new Map<string, PendingExpectation>();
    pending.set(activityId, { kind: 'absent' });
    windows.set(id, pending);
  }
}

/** Prevents a stale GSI body from replacing a projection a successful write already proved. */
export function guardAgendaResponse(
  client: QueryClient,
  queryKey: readonly unknown[],
  incoming: AgendaData,
): AgendaData {
  const windows = pendingByClient.get(client);
  const pending = windows?.get(keyId(queryKey));
  if (pending === undefined) return incoming;

  let result = incoming;
  for (const [activityId, expectation] of [...pending]) {
    const satisfied =
      expectation.kind === 'absent'
        ? !contains(incoming, activityId)
        : expectation.kind === 'version'
          ? observed(incoming, activityId, expectation.version)
          : expectation.version !== undefined &&
            observed(incoming, activityId, expectation.version);
    if (satisfied) {
      pending.delete(activityId);
      if (expectation.kind === 'protected' && expectation.version !== undefined) {
        clearReconciledIntentIfUnprotected(client, activityId, expectation.version);
      }
      continue;
    }
    const current = client.getQueryData<AgendaData>(queryKey);
    if (current !== undefined) {
      result = preserveActivityRows(result, current, activityId, agendaClock(client));
    }
  }
  if (pending.size === 0) windows?.delete(keyId(queryKey));
  return result;
}

/** Arms per-window protection before a recurrence PATCH can leave the device. */
export function protectRecurrenceEdit(client: QueryClient, activityId: string): void {
  let windows = pendingByClient.get(client);
  if (windows === undefined) {
    windows = new Map();
    pendingByClient.set(client, windows);
  }
  for (const [key] of client.getQueriesData<AgendaData>({ queryKey: AGENDA_KEY })) {
    const pending = windows.get(keyId(key)) ?? new Map<string, PendingExpectation>();
    pending.set(activityId, { kind: 'protected' });
    windows.set(keyId(key), pending);
  }
}

/** Clears protection after cancellation or permanent rejection. */
export function clearRecurrenceEditProtection(
  client: QueryClient,
  activityId: string,
): void {
  const windows = pendingByClient.get(client);
  if (windows === undefined) return;
  for (const [id, pending] of windows) {
    if (pending.get(activityId)?.kind === 'protected') pending.delete(activityId);
    if (pending.size === 0) windows.delete(id);
  }
}

/** Adds the acknowledged META version without allowing an unproven body to erase rows. */
function expectProtectedVersion(
  client: QueryClient,
  activityId: string,
  version: string,
): void {
  protectRecurrenceEdit(client, activityId);
  const windows = pendingByClient.get(client);
  for (const pending of windows?.values() ?? []) {
    if (pending.get(activityId)?.kind === 'protected') {
      pending.set(activityId, { kind: 'protected', version });
    }
  }
}

function preserveActivityRows(
  incoming: AgendaData,
  current: AgendaData,
  activityId: string,
  clock: AgendaProjectionClock,
): AgendaData {
  const currentByDate = new Map(
    current.days.map((day) => [
      day.date,
      uniqueItems(day).filter((item) => item.activityId === activityId),
    ]),
  );
  return {
    ...incoming,
    days: incoming.days.map((day) =>
      projectDay(
        day,
        [
          ...uniqueItems(day).filter((item) => item.activityId !== activityId),
          ...(currentByDate.get(day.date) ?? []),
        ],
        clock,
      ),
    ),
  };
}

/** Atomically replaces one activity across a single cached window, including zero rows. */
export function spliceActivityAgenda(
  agenda: AgendaData,
  canonical: ActivityAgendaData,
  clock: AgendaProjectionClock,
): AgendaData {
  const rowsByDate = new Map<string, ActivityAgendaData['rows']>();
  for (const row of canonical.rows) {
    if (row.item.activityId !== canonical.activityId) continue;
    const rows = rowsByDate.get(row.date) ?? [];
    rows.push(row);
    rowsByDate.set(row.date, rows);
  }
  return {
    ...agenda,
    days: agenda.days.map((day) =>
      projectDay(
        day,
        [
          ...uniqueItems(day).filter((item) => item.activityId !== canonical.activityId),
          ...(rowsByDate.get(day.date) ?? []).map((row) => row.item),
        ],
        clock,
      ),
    ),
  };
}

type ActivityAgendaLoader = (
  activityId: string,
  query: AgendaQuery,
) => Promise<ActivityAgendaData>;

/** Strongly reconciles every applicable cached window for one acknowledged recurrence PATCH. */
export async function reconcileRecurrenceEdit(
  client: QueryClient,
  activityId: string,
  version: string,
  load: ActivityAgendaLoader = (id, query) => getActivityAgenda(apiClient, id, query),
): Promise<boolean> {
  expectProtectedVersion(client, activityId, version);
  const keys = client
    .getQueriesData<AgendaData>({ queryKey: AGENDA_KEY })
    .map(([key]) => key as AgendaQueryKey);
  let complete = true;
  await Promise.all(
    keys.map(async (key) => {
      const [, from, to, tz, include] = key;
      try {
        const canonical = await load(activityId, {
          from,
          to,
          tz,
          ...(include === null ? {} : { include }),
        });
        if (canonical.activityId !== activityId || canonical.activityVersion < version) {
          complete = false;
          return;
        }
        client.setQueryData<AgendaData>(key, (agenda) =>
          agenda === undefined
            ? agenda
            : spliceActivityAgenda(agenda, canonical, agendaClock(client)),
        );
        const pending = pendingByClient.get(client)?.get(keyId(key));
        if (pending?.get(activityId)?.kind === 'protected') pending.delete(activityId);
        clearReconciledIntentIfUnprotected(client, activityId, canonical.activityVersion);
        if (pending?.size === 0) pendingByClient.get(client)?.delete(keyId(key));
      } catch {
        complete = false;
      }
    }),
  );
  return complete;
}

/** Ordinary/manual refresh: merge unaffected rows, then retry any versioned strong reads. */
export async function loadAgendaWithReconciliation(
  client: QueryClient,
  queryKey: AgendaQueryKey,
  query: AgendaQuery,
  signal?: AbortSignal,
  dependencies: {
    readonly ordinary?: (query: AgendaQuery, signal?: AbortSignal) => Promise<AgendaData>;
    readonly targeted?: ActivityAgendaLoader;
  } = {},
): Promise<AgendaData> {
  let result = guardAgendaResponse(
    client,
    queryKey,
    await (
      dependencies.ordinary ??
      ((request, requestSignal) => getAgenda(apiClient, request, requestSignal))
    )(query, signal),
  );
  const pending = pendingByClient.get(client)?.get(keyId(queryKey));
  for (const [activityId, expectation] of [...(pending ?? [])]) {
    if (expectation.kind !== 'protected' || expectation.version === undefined) continue;
    try {
      const canonical = await (
        dependencies.targeted ??
        ((id, request) => getActivityAgenda(apiClient, id, request, signal))
      )(activityId, query);
      if (canonical.activityVersion < expectation.version) continue;
      result = spliceActivityAgenda(result, canonical, agendaClock(client));
      pending?.delete(activityId);
      clearReconciledIntentIfUnprotected(client, activityId, canonical.activityVersion);
    } catch {
      // Protected rows remain installed; the next manual refresh retries this exact read.
    }
  }
  if (pending?.size === 0) pendingByClient.get(client)?.delete(keyId(queryKey));
  return result;
}

function clearReconciledIntentIfUnprotected(
  client: QueryClient,
  activityId: string,
  proofVersion: string,
): void {
  const stillProtected = [...(pendingByClient.get(client)?.values() ?? [])].some(
    (pending) => pending.get(activityId)?.kind === 'protected',
  );
  if (stillProtected) return;
  const log = getActiveIntentLog();
  if (log === undefined) return;
  for (const intent of log.snapshotFor(activityId)) {
    if (
      intent.status === 'acknowledged' &&
      intent.reconciliationVersion !== undefined &&
      intent.reconciliationVersion <= proofVersion &&
      isRecurrenceEditMutation(intent.mutationKey, intent.variables)
    ) {
      void log.acknowledge(intent.intentId);
    }
  }
}

export interface AgendaReconciliationVersion {
  readonly activityId: string;
  readonly version: string;
  /** A one-off outside a cached window is authoritatively absent and needs no GSI proof. */
  readonly relevantDate?: string;
}

type AgendaLoader = (query: AgendaQuery) => Promise<AgendaData>;

/** Bounded, version-aware reconciliation for every mounted/cached agenda window. */
export async function reconcileAgendaProjection(
  client: QueryClient,
  expected: AgendaReconciliationVersion,
  load: AgendaLoader = (query) => getAgenda(apiClient, query, undefined, true),
  wait: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<boolean> {
  const keys = client
    .getQueriesData<AgendaData>({ queryKey: AGENDA_KEY })
    .map(([key]) => key as AgendaQueryKey)
    .filter(
      ([, from, to]) =>
        expected.relevantDate === undefined ||
        (expected.relevantDate >= from && expected.relevantDate <= to),
    );
  if (keys.length === 0) return true;

  let windows = pendingByClient.get(client);
  if (windows === undefined) {
    windows = new Map();
    pendingByClient.set(client, windows);
  }
  for (const key of keys) {
    const pending = windows.get(keyId(key)) ?? new Map<string, PendingExpectation>();
    const current = pending.get(expected.activityId);
    /**
     * A pending deletion outranks any version: the Activity is gone, so waiting for it to be
     * stamped would wedge the window on a proof that can never arrive.
     */
    if (
      current?.kind !== 'absent' &&
      (current === undefined ||
        (current.kind === 'version' && current.version < expected.version))
    ) {
      pending.set(expected.activityId, { kind: 'version', version: expected.version });
    }
    windows.set(keyId(key), pending);
  }

  const remaining = new Set(keys.map(keyId));
  /** The freshest body each unconvinced window produced, kept for the exhaustion branch. */
  const latest = new Map<string, AgendaData>();

  for (const delay of RECONCILE_DELAYS_MS) {
    if (delay > 0) await wait(delay);
    await Promise.all(
      keys
        .filter((key) => remaining.has(keyId(key)))
        .map(async (key) => {
          try {
            const [, from, to, tz, include] = key;
            const incoming = await load({
              from,
              to,
              tz,
              ...(include === null ? {} : { include }),
            });
            latest.set(keyId(key), incoming);
            const guarded = guardAgendaResponse(client, key, incoming);
            if (guarded === incoming) {
              client.setQueryData(key, incoming);
              remaining.delete(keyId(key));
            }
          } catch {
            // A bounded retry remains; ordinary query error handling owns the eventual UI.
          }
        }),
    );
    if (remaining.size === 0) return true;
  }

  /**
   * **Exhaustion installs the freshest body rather than leaving the window stranded.**
   *
   * The guard exists to stop a stale GSI read overwriting state a write has already proved —
   * a race that resolves in seconds. It was never meant to withhold data indefinitely, but
   * that is what it did: when the ladder ran out unconvinced, this returned `false` and
   * nothing retried, so whatever the caller had done to the cache in anticipation became
   * permanent until the user manually refreshed.
   *
   * Both reported symptoms are that one behaviour. A **new** recurring activity kept the
   * single anchor-date row `applyCreate` wrote, with no repeat glyph and no later
   * occurrences. An activity **switched** to recurring kept the deletion the patch branch
   * performed, and vanished. In each case the server's answer was correct on the wire and the
   * client refused to install it, because adding recurrence moves the index row from the `#S`
   * bucket to `#R` and `observedProjectionVersions` only stamps a version once the row it
   * reads matches META — which, mid-migration, it does not.
   *
   * After the full ladder the likeliest reading is that no version is coming for this window,
   * and a possibly-stale expansion beats a row the user has to know to refresh for. The next
   * natural refetch corrects it either way.
   */
  for (const key of keys) {
    const id = keyId(key);
    if (!remaining.has(id)) continue;
    const body = latest.get(id);
    if (body === undefined) continue;

    const pending = pendingByClient.get(client)?.get(id);
    /**
     * **A pending deletion is never relaxed.** `absent` converges monotonically — a deleted
     * Activity does not come back — so an unsatisfied one means this body genuinely still
     * carries a row that is gone, and installing it would resurrect a row that `404`s when
     * tapped. Only the version expectations, which may have no proof coming, are dropped.
     */
    const resurrects = [...(pending ?? [])].some(
      ([activityId, expectation]) =>
        expectation.kind === 'absent' && contains(body, activityId),
    );
    if (resurrects) continue;

    /**
     * Relax only the ordinary version expectation this legacy ladder owns. A protected
     * recurrence edit may share the window and must survive another Activity's exhausted
     * reconciliation.
     */
    for (const [activityId, expectation] of [...(pending ?? [])]) {
      if (expectation.kind === 'version') pending?.delete(activityId);
    }
    const guarded = guardAgendaResponse(client, key, body);
    client.setQueryData(key, guarded);
    remaining.delete(id);
  }
  return remaining.size === 0;
}

/**
 * Writes a server-confirmed activity into the cached agenda windows (P2-46).
 *
 * **The problem this solves.** The agenda is served from `GSI1`, and a global secondary index
 * is eventually consistent — a consistent read on one does not exist. Invalidating the agenda
 * after a write fires a refetch within tens of milliseconds, which races the index write and
 * frequently loses. The server answers `200` with pre-write data, the client caches it, and
 * nothing retries, so Today shows a stale day until something else invalidates. Measured on a
 * local create: `201` at +1922 ms, refetch issued at +1967 ms, and the row absent from a
 * response the API served correctly six seconds later.
 *
 * Invalidation alone therefore cannot be the mechanism that makes a write reach Today; it can
 * only be the reconciliation behind one. Completing and snoozing never had this bug precisely
 * because they project into the cache first and treat the refetch as confirmation.
 *
 * Everything here is projected from the **server's response**, so there is no rollback path
 * and no invented identifier: by the time this runs the write is durable and its canonical
 * shape is known. Each projection is idempotent, so a refetch that did win the race cannot
 * produce a duplicate row.
 */
export function projectActivityWrite(
  client: QueryClient,
  mutationKey: MutationKey | undefined,
  data: unknown,
  variables?: unknown,
): boolean {
  const tag = activityMutationTag(mutationKey);
  if (tag === undefined) return false;
  const activity = activityFrom(data);
  if (activity === undefined) return false;

  const clock = agendaClock(client);

  if (tag === 'create' || tag === 'duplicate') {
    update(client, (agenda) =>
      applyCreate(agenda, {
        activity,
        ...clock,
        // A create may already be represented by its durable local projection. The 201 is
        // canonical and replaces those provisional rows atomically across each window.
        ...(tag === 'create' ? { reconcile: true } : {}),
      }),
    );

    /**
     * **A new series is locally complete, then canonically reconciled.**
     *
     * `applyCreate` expands a create with the shared recurrence engine across each cached
     * window, which is safe because a new series has no server occurrence history or overrides.
     * This reconciliation still runs because the agenda endpoint owns canonical projection
     * fields and its version proof is what allows later server bodies to replace local state.
     *
     * This exception is intentionally create-only. A recurrence edit can depend on occurrence
     * history absent from the Activity response and remains server-expanded below.
     */
    if (activity.recurrence !== undefined && typeof activity.updatedAt === 'string') {
      void reconcileAgendaProjection(client, {
        activityId: activity.activityId,
        version: activity.updatedAt,
        ...(activity.schedule?.date === undefined
          ? {}
          : { relevantDate: activity.schedule.date }),
      });
    }
    return true;
  }

  /**
   * A patch changes what the row *says* — its title, its type, whether it repeats — without
   * moving it. Unclaimed, it fell through to `refreshActivityLists`, which marks the agenda
   * stale with `refetchType: 'none'`; so nothing projected and nothing refetched, and Today
   * kept the pre-patch row for up to a minute. See `applyPatch` for what is and is not
   * derivable here.
   */
  if (tag === 'patch') {
    if (isRecurrenceEditMutation(mutationKey, variables)) {
      if (typeof activity.updatedAt === 'string') {
        expectProtectedVersion(client, activity.activityId, activity.updatedAt);
      }
      return true;
    }
    update(client, (agenda) => applyPatch(agenda, { activity, ...clock }));
    return true;
  }

  /**
   * Conversion has a complete server answer: remove every generated occurrence, then place
   * the surviving one-off from the Activity schedule returned by the atomic operation.
   */
  if (tag === 'convert-recurrence') {
    update(client, (agenda) =>
      applyCreate(applyDelete(agenda, { activityId: activity.activityId, ...clock }), {
        activity,
        ...clock,
      }),
    );
    if (typeof activity.updatedAt === 'string') {
      void reconcileAgendaProjection(client, {
        activityId: activity.activityId,
        version: activity.updatedAt,
        ...(activity.schedule?.date === undefined
          ? {}
          : { relevantDate: activity.schedule.date }),
      });
    }
    return true;
  }

  /**
   * A delete takes the row with it. The detail screen leaves on success, but the Today tab it
   * returns to is already mounted and refetches nothing — so the deleted row stayed visible.
   */
  if (tag === 'delete') {
    expectAbsent(client, activity.activityId);
    update(client, (agenda) =>
      applyDelete(agenda, { activityId: activity.activityId, ...clock }),
    );
    return true;
  }

  /**
   * **Deliberately unprojected**, and the exhaustiveness check below is what makes that a
   * decision rather than an omission.
   *
   * `snooze`/`unsnooze` are projected by their **callers**, before the request goes out, through
   * `applySnooze` — projecting again here would be a second write of the same truth and would
   * arrive a round trip late. Today does it in `useAgendaActivityActions`; the detail screen
   * does it through `projectOptimisticSnooze` below. Reminder writes change no list and no
   * agenda window at all, which is why `changesActivityLists` already excludes them.
   */
  if (
    tag === 'snooze' ||
    tag === 'unsnooze' ||
    tag === 'reminder-create' ||
    tag === 'reminder-delete'
  ) {
    return false;
  }

  /**
   * **An occurrence reschedule moves one day, and reads its target from the request.**
   *
   * `scheduleOccurrence` writes an `Occurrence` override and leaves `ACT#/META` alone, so the
   * response still carries the *series anchor* — projecting from it would move the row to the
   * wrong day at the wrong time. The new date and time exist only in what was sent.
   *
   * Scope also has to travel: `applyReschedule` matches `activityId` **and** `occurrenceDate`,
   * and passing none matched no row of a series at all. The write then fell through to the
   * `applyCreate` fallback below, which inserted a second row for an activity the window
   * already held — a duplicated task on Today, reachable as soon as the detail screen began
   * sending occurrence scope.
   */
  if (tag === 'schedule' && occurrenceDateFrom(variables) !== undefined) {
    const requested = scheduleRequestFrom(variables);
    const occurrenceDate = occurrenceDateFrom(variables);
    if (requested !== undefined && occurrenceDate !== undefined) {
      update(client, (agenda) =>
        applyReschedule(agenda, {
          activityId: activity.activityId,
          occurrenceDate,
          date: requested.date,
          ...(requested.time === undefined ? {} : { time: requested.time }),
          ...(requested.endTime === undefined ? {} : { endTime: requested.endTime }),
          ...clock,
        }),
      );
    }
    return true;
  }

  if (tag === 'schedule') {
    const date = activity.schedule?.date ?? null;
    update(client, (agenda) => {
      const moved = applyReschedule(agenda, {
        activityId: activity.activityId,
        date,
        ...(activity.schedule?.time === undefined
          ? {}
          : { time: activity.schedule.time }),
        ...(activity.schedule?.endTime === undefined
          ? {}
          : { endTime: activity.schedule.endTime }),
        ...clock,
      });
      if (moved !== agenda) return moved;

      /**
       * **A row can also be rescheduled *into* a window it was never in.**
       *
       * `applyReschedule` moves a row the cached agenda already holds; asked about one it does
       * not, it correctly does nothing. But moving a plan from next Friday to today is exactly
       * that case — Today's cached window has never seen it — so the projection was a no-op and
       * Today only gained the row when something else happened to refetch. Reported as "it takes
       * some time to show up".
       *
       * `applyCreate` is the right fallback rather than a second insert path: it places a
       * server-confirmed Activity only when the destination date is inside this window, and it
       * is idempotent, so a refetch that won the race cannot double the row.
       */
      return applyCreate(agenda, { activity, ...clock });
    });
    return true;
  }

  /**
   * Completion, and its compensating undo, from **anywhere**.
   *
   * The agenda screen projects these itself before the request goes out, so Today has always
   * felt instant. The detail screen does not — and once the agenda stopped refetching on
   * invalidation, a completion recorded from a detail screen reached the server and never
   * reached Today, because a mounted tab has nothing to trigger a refetch. Plans looked
   * correct only because navigating to it remounts and refetches.
   *
   * Projecting here rather than in either screen means one behaviour for the row checkbox, the
   * swipe action, the passed-plan sheet, the detail button, and a mutation replayed from the
   * offline queue after a restart.
   */
  if (tag === 'complete' || tag === 'uncomplete' || tag === 'skip') {
    /**
     * The **detail cache** as well as the agenda.
     *
     * Completing or undoing from a Today row never touched `['activity', id]`, and that query
     * has a 60-second stale time — so opening the detail screen after an undo showed the
     * activity still completed, sometimes for a full minute, and the completion button showed
     * the resolved state long after the row had gone back to normal. The server's response is
     * the activity, so there is nothing to derive.
     *
     * **Both keys, because an occurrence has its own** (P2-53): a screen opened on one day of a
     * series reads `['activity', id, 'occurrence', date]` and never the series entry, so writing
     * only the series one left that screen exactly as stale as writing nothing. Found while
     * fixing the same mistake in `projectOptimisticSnooze`. The series entry is still written —
     * a one-off, and any series detail also open, both read it.
     */
    const occurrenceDate = occurrenceDateFrom(variables);
    const resolvedKeys = [
      activityKey(activity.activityId),
      ...(occurrenceDate === undefined
        ? []
        : [
            activityDetailKey({
              kind: 'occurrence',
              activityId: activity.activityId,
              date: occurrenceDate,
            }),
          ]),
    ];
    for (const key of resolvedKeys) {
      client.setQueryData<{ activity: Activity }>(key, (previous) =>
        previous === undefined ? previous : { ...previous, activity },
      );
    }

    /**
     * **The occurrence the server just wrote, not only the Activity beside it.**
     *
     * `ActivityCompletionResult` carries the authoritative `occurrence` for an occurrence-scoped
     * complete, uncomplete or skip, and this dropped it — so the cached occurrence went on
     * reporting `status: 'scheduled'` after a skip, and the resolved state existed **only** as
     * the screen's own local projection. That is invisible until something refetches: a stale
     * mark left by an earlier write on the same activity — a snooze, say — makes the next
     * window focus refetch, and a refetch that raced the write returns pre-skip data and caches
     * it over the projection. A plain skip leaves no such pending mark, which is why the same
     * two taps behave differently depending on what came before them.
     *
     * Writing the server's own answer is what this module's opening note prescribes and what
     * makes the cache, rather than a component's state, the thing that remembers.
     */
    /**
     * **And symmetrically on the way back**, which is the half that made the disagreement
     * durable rather than momentary.
     *
     * An occurrence `uncomplete` **deletes** the `OCC#` row and returns no `occurrence` at all —
     * `data-model.md` §6.3: "the absence of an Occurrence row means scheduled, not yet acted
     * on". Reading the response alone therefore left the cached occurrence still claiming
     * `skipped_occurrence` after the skip had been undone. The screen looked right only while
     * its own local projection applied; a remount, a back-and-forward, anything that dropped
     * that projection and fell back to the cache brought the resolved block straight back. Both
     * directions of the reported flicker are this one asymmetry.
     *
     * The early-return case — uncompleting something that was snoozed or untouched — does carry
     * an `occurrence`, and is left alone, because nothing was deleted.
     */
    const resolvedOccurrence = occurrenceFrom(data);
    const clearsOccurrence =
      tag === 'uncomplete' && !('occurrence' in (data as Record<string, unknown>));
    if (
      (resolvedOccurrence !== undefined || clearsOccurrence) &&
      occurrenceDate !== undefined
    ) {
      client.setQueryData<ActivityDetail>(
        activityDetailKey({
          kind: 'occurrence',
          activityId: activity.activityId,
          date: occurrenceDate,
        }),
        (previous) =>
          previous?.occurrence === undefined
            ? previous
            : {
                ...previous,
                occurrence: clearsOccurrence
                  ? { ...previous.occurrence, status: 'scheduled', isSnoozed: false }
                  : {
                      ...previous.occurrence,
                      status: (resolvedOccurrence as { status: AgendaItemStatus }).status,
                    },
              },
      );
    }

    const target = {
      activityId: activity.activityId,
      ...(occurrenceDate === undefined ? {} : { occurrenceDate }),
      ...clock,
    };

    /**
     * **A declined outcome is a skip, and the server has already said so.**
     *
     * `POST /complete` carries the outcome, and `completionService` stores a negative one —
     * `didnt_happen`, `didnt_go` — as `status: 'skipped'`. This branch projected every
     * `complete` as a completion regardless, so the row went: optimistically skipped by
     * `resolvePassed` (which does read the outcome), then **overwritten** by this the moment the
     * response landed. Answering `Didn't go` on Today therefore settled on a struck-through row
     * reading `Attended` — the founder's report, and the same defect the detail screen had.
     *
     * Read from the response rather than re-derived: the server's `outcome` is the fact, and for
     * an occurrence the Activity's own status never moves and so cannot be consulted.
     */
    if (tag === 'skip' || isNegativeOutcome(outcomeFrom(data))) {
      update(client, (agenda) => applySkip(agenda, { ...target, skipped: true }));
      return true;
    }

    update(client, (agenda) =>
      applyCompletion(
        agenda,
        tag === 'complete'
          ? { ...target, completed: true }
          : {
              ...target,
              completed: false,
              // The server's own word for where the row goes back to.
              restoredStatus:
                activity.schedule?.date === undefined ? 'saved' : 'scheduled',
            },
      ),
    );
    return true;
  }

  /**
   * **The guard that makes this list exhaustive.**
   *
   * Every branch above narrows `tag`, so by here it is `never` — and adding a key to
   * `activityMutationKeys` widens `ActivityMutationTag`, breaks that assignment, and fails
   * `pnpm typecheck` until the new write says what it does to the cached agenda. Before this,
   * an unhandled key fell silently to `return false` while `changesActivityLists` still opted
   * it into `refreshActivityLists` — stale-marked with `refetchType: 'none'` and nothing to
   * correct it. That is how `patch` and `delete` shipped unprojected, and why the failure was a
   * quiet wrong screen rather than an error.
   */
  const unhandled: never = tag;
  return unhandled;
}

export interface PendingActivityCreateVariables {
  input: CreateActivityInput;
  idempotencyKey: string;
}

export interface PendingActivityCreateProjection {
  readonly projected: boolean;
  readonly seededKey?: ReturnType<typeof agendaKey>;
}

/**
 * Projects a durable, unacknowledged create into every cached agenda window.
 *
 * The global MutationCache appends the intent first; TanStack then invokes the create
 * default's `onMutate`, which calls this function. That preserves Phase 2.6's ordering:
 * durable write, local projection, network request. It is also safe to call again during
 * replay or cold-start restoration because `applyPendingCreate` is idempotent.
 */
export function projectPendingActivityCreate(
  client: QueryClient,
  variables: PendingActivityCreateVariables,
  mintedAt = new Date().toISOString(),
): PendingActivityCreateProjection {
  const input = (variables as Partial<PendingActivityCreateVariables> | undefined)?.input;
  const activityId = input?.activityId;
  if (input === undefined || activityId === undefined) return { projected: false };
  const clock = agendaClock(client);
  const seededTodayKey = seedPendingTodayWindow(
    client,
    input,
    activityId,
    mintedAt,
    clock,
  );
  update(client, (agenda) =>
    applyPendingCreate(agenda, {
      input,
      activityId,
      mintedAt,
      ...clock,
    }),
  );
  if (seededTodayKey !== undefined) {
    void client.invalidateQueries({ queryKey: seededTodayKey, refetchType: 'none' });
  }
  return {
    projected: true,
    ...(seededTodayKey === undefined ? {} : { seededKey: seededTodayKey }),
  };
}

/**
 * Gives Today a minimal local window when no server response has ever been cached.
 *
 * Without this, `setQueriesData` has nothing to update on a first offline launch and Today
 * falls through to its no-data error even though the durable create is valid local data. The
 * seeded window is immediately stale and contains only this device's pending projection; the
 * connectivity status communicates that the rest of the server view is unavailable.
 */
function seedPendingTodayWindow(
  client: QueryClient,
  input: CreateActivityInput,
  activityId: string,
  mintedAt: string,
  clock: AgendaProjectionClock,
): ReturnType<typeof agendaKey> | undefined {
  const timezone = resolveAgendaTimezone(client);
  const tomorrow = addWallDays(clock.today, 1);
  const key = agendaKey(clock.today, tomorrow, timezone, TODAY_AGENDA_INCLUDE);
  if (client.getQueryData<AgendaData>(key) !== undefined) return undefined;

  const empty: AgendaData = {
    days: [
      { date: clock.today, schedule: [], anytime: [], earlier: [] },
      { date: tomorrow, schedule: [], anytime: [], earlier: [] },
    ],
    warnings: [],
  };
  const projected = applyPendingCreate(empty, {
    input,
    activityId,
    mintedAt,
    ...clock,
  });
  if (!contains(projected, activityId)) return undefined;

  client.setQueryData(key, projected);
  return key;
}

export interface PendingCreateProjectionIntent {
  readonly mutationKey: readonly string[];
  readonly variables: unknown;
  readonly createdAt: number;
}

export interface RecurrenceEditProjectionIntent {
  readonly intentId: string;
  readonly entityId: string;
  readonly mutationKey: readonly string[];
  readonly variables: unknown;
  readonly status: string;
  readonly reconciliationVersion?: string;
}

/** Restores per-activity protection from the durable log after a process restart. */
export function restoreRecurrenceEditProtection(
  client: QueryClient,
  intents: readonly RecurrenceEditProjectionIntent[],
): number {
  let restored = 0;
  for (const intent of intents) {
    if (
      intent.mutationKey[0] !== 'activity' ||
      intent.mutationKey[1] !== 'patch' ||
      !isRecurrenceEditMutation(intent.mutationKey, intent.variables) ||
      (intent.status !== 'queued' &&
        intent.status !== 'in_flight' &&
        intent.status !== 'acknowledged')
    ) {
      continue;
    }
    protectRecurrenceEdit(client, intent.entityId);
    if (intent.reconciliationVersion !== undefined) {
      expectProtectedVersion(client, intent.entityId, intent.reconciliationVersion);
    }
    restored += 1;
  }
  return restored;
}

/** Rebuilds pending create rows from the durable log after query-cache restoration. */
export function restorePendingActivityCreates(
  client: QueryClient,
  intents: readonly PendingCreateProjectionIntent[],
): number {
  let projected = 0;
  for (const intent of intents) {
    if (intent.mutationKey[0] !== 'activity' || intent.mutationKey[1] !== 'create') {
      continue;
    }
    if (
      projectPendingActivityCreate(
        client,
        intent.variables as PendingActivityCreateVariables,
        new Date(intent.createdAt).toISOString(),
      ).projected
    ) {
      projected += 1;
    }
  }
  return projected;
}

/** Narrows a `MutationKey` to the activity tags this projector is required to be total over. */
function activityMutationTag(
  mutationKey: MutationKey | undefined,
): ActivityMutationTag | undefined {
  if (!Array.isArray(mutationKey)) return undefined;
  const [scope, tag] = mutationKey as readonly unknown[];
  if (scope !== 'activity' || typeof tag !== 'string') return undefined;
  return ACTIVITY_MUTATION_TAGS.has(tag) ? (tag as ActivityMutationTag) : undefined;
}

const ACTIVITY_MUTATION_TAGS: ReadonlySet<string> = new Set(
  Object.values(activityMutationKeys).map(([, tag]) => tag),
);

/**
 * Projects completion state across every cached surface before its request settles.
 *
 * The agenda row, ordinary detail and occurrence detail are one user-visible fact even while
 * the durable intent is queued offline. The returned rollback restores the same snapshots if
 * the coordinator refuses or permanently rejects that fact; transient transport failure keeps
 * every projection in place for replay.
 */
export function projectOptimisticCompletion(
  client: QueryClient,
  variables: AgendaMutationTarget &
    ({ completed: true } | { completed: false; restoredStatus: 'saved' | 'scheduled' }),
  clockOverride?: AgendaProjectionClock,
): () => void {
  const clock = clockOverride ?? agendaClock(client);
  const snapshots = client
    .getQueriesData<AgendaData>({ queryKey: AGENDA_KEY })
    .map(([queryKey, agenda]) => ({
      queryKey,
      found: agenda === undefined ? undefined : findAgendaItem(agenda, variables),
    }));

  update(client, (agenda) => applyCompletion(agenda, { ...variables, ...clock }));

  const detailKey =
    variables.occurrenceDate === undefined
      ? activityKey(variables.activityId)
      : activityDetailKey({
          kind: 'occurrence',
          activityId: variables.activityId,
          date: variables.occurrenceDate,
        });
  const detailBefore = client.getQueryData<ActivityDetail>(detailKey);
  if (detailBefore !== undefined) {
    client.setQueryData<ActivityDetail>(detailKey, (previous) => {
      if (previous === undefined) return previous;
      if (variables.occurrenceDate !== undefined) {
        return previous.occurrence === undefined
          ? previous
          : {
              ...previous,
              occurrence: {
                ...previous.occurrence,
                status: variables.completed ? 'completed_occurrence' : 'scheduled',
              },
            };
      }
      if (variables.completed) {
        return {
          ...previous,
          activity: { ...previous.activity, status: 'completed' },
        };
      }
      const {
        completedAt: _completedAt,
        outcome: _outcome,
        ...activity
      } = previous.activity;
      return {
        ...previous,
        activity: { ...activity, status: variables.restoredStatus },
      };
    });
  }

  return () => {
    for (const { queryKey, found } of snapshots) {
      client.setQueryData<AgendaData>(queryKey, (agenda) => {
        if (agenda === undefined || found === undefined) return agenda;
        return replaceAgendaItem(agenda, variables, found.item, found.sourceDate, clock);
      });
    }
    if (detailBefore !== undefined) client.setQueryData(detailKey, detailBefore);
  };
}

/**
 * Projects a snooze into every cached agenda window, and returns the undo.
 *
 * The same shape as `projectOptimisticCompletion`, and here for the same reason: the detail
 * screen can now snooze, and a write it does not project is a write Today and Plans do not show
 * until something else refetches them. Reported as "snoozing changes the time on the activity
 * details page but not on Today", with a visible delay before either agreed — the delay being
 * the round trip this removes from the path.
 */
export function projectOptimisticSnooze(
  client: QueryClient,
  variables: AgendaMutationTarget & { date: string; time: string },
): () => void {
  const clock = agendaClock(client);
  const snapshots = client
    .getQueriesData<AgendaData>({ queryKey: AGENDA_KEY })
    .map(([queryKey, agenda]) => ({
      queryKey,
      found: agenda === undefined ? undefined : findAgendaItem(agenda, variables),
    }));

  update(client, (agenda) =>
    applySnooze(agenda, { ...variables, ...clock, snoozed: true }),
  );

  /**
   * **And the detail query, which is the screen the user is standing on.**
   *
   * `refreshActivityDetails` marks `['activity', id]` stale with `refetchType: 'none'` — right,
   * and deliberately so: P2-46 established that a refetch racing an eventually-consistent index
   * can cache pre-write data over newer local state. But "mark stale, do not refetch" only works
   * when something *projects*. Snooze projected the agenda and not this, so the screen that
   * raised the sheet kept its old time until an unrelated remount or window focus happened to
   * refetch it — sometimes seconds, sometimes a minute, sometimes not until the user left and
   * came back. That is the reported "long gap with an update after 1 min", and the
   * unpredictability is the same defect: the trigger was incidental rather than the write.
   *
   * **The occurrence key, not the series key.** P2-53 gave an occurrence-targeted read its own
   * cache entry — `['activity', id, 'occurrence', date]` — precisely so an occurrence never
   * aliases the series. A projection written to `activityKey` therefore lands in an entry the
   * screen showing that day is not reading, which looks exactly like no projection at all.
   */
  const detailKey =
    variables.occurrenceDate === undefined
      ? activityKey(variables.activityId)
      : activityDetailKey({
          kind: 'occurrence',
          activityId: variables.activityId,
          date: variables.occurrenceDate,
        });
  const detailBefore = client.getQueryData<ActivityDetail>(detailKey);
  if (detailBefore !== undefined) {
    /**
     * **Both storage shapes**, because a snooze means one thing and is stored two ways: an
     * `OCC#` override for a series, `snoozedUntil` on the Activity for a one-off
     * (`snoozeActivity`'s two branches). Projecting only the occurrence shape left a snoozed
     * one-off's detail screen on its scheduled time — and, because the snooze sheet computes
     * its options from the time it is shown, made repeating a snooze compound on a series and
     * not on a one-off. One fork, two visible behaviours.
     */
    client.setQueryData<ActivityDetail>(
      detailKey,
      detailBefore.occurrence === undefined
        ? {
            ...detailBefore,
            activity: { ...detailBefore.activity, snoozedUntil: variables.time },
          }
        : {
            ...detailBefore,
            occurrence: {
              ...detailBefore.occurrence,
              time: variables.time,
              isSnoozed: true,
            },
          },
    );
  }

  return () => {
    for (const { queryKey, found } of snapshots) {
      client.setQueryData<AgendaData>(queryKey, (agenda) => {
        if (agenda === undefined || found === undefined) return agenda;
        return replaceAgendaItem(agenda, variables, found.item, found.sourceDate, clock);
      });
    }
    if (detailBefore !== undefined) client.setQueryData(detailKey, detailBefore);
  };
}

/**
 * The date and time a schedule write asked for.
 *
 * Read from the request for the same reason occurrence scope is: an occurrence override never
 * moves `ACT#/META`, so the response describes the series, not the day that just moved.
 */
function scheduleRequestFrom(
  variables: unknown,
): { date: string | null; time?: string; endTime?: string } | undefined {
  const input = inputOf(variables);
  if (input === undefined) return undefined;
  const { date, time, endTime } = input as {
    date?: unknown;
    time?: unknown;
    endTime?: unknown;
  };
  if (date !== null && typeof date !== 'string') return undefined;
  return {
    date,
    ...(typeof time === 'string' ? { time } : {}),
    ...(typeof endTime === 'string' ? { endTime } : {}),
  };
}

/** Occurrence scope travels in the request, not the response. */
function occurrenceDateFrom(variables: unknown): string | undefined {
  const input = inputOf(variables);
  if (input === undefined) return undefined;
  const date = (input as { occurrenceDate?: unknown }).occurrenceDate;
  return typeof date === 'string' ? date : undefined;
}

/** The `input` of a mutation's variables, at the `unknown` boundary these callers sit on. */
function inputOf(variables: unknown): object | undefined {
  if (typeof variables !== 'object' || variables === null) return undefined;
  const input = (variables as { input?: unknown }).input;
  return typeof input === 'object' && input !== null ? input : undefined;
}

/** Whether this PATCH changes series projection rather than ordinary row text. */
export function isRecurrenceEditMutation(
  mutationKey: MutationKey | undefined,
  variables: unknown,
): boolean {
  if (activityMutationTag(mutationKey) !== 'patch') return false;
  const input = inputOf(variables);
  return input !== undefined && Object.hasOwn(input, 'recurrence');
}

/** Both a bare Activity and a `{ activity }` envelope reach this from different endpoints. */
/**
 * The occurrence a completion response reports, when it is occurrence-scoped.
 *
 * Only `status` is taken from it: the effective date and time on the detail projection are
 * derived server-side from the override plus the series, and an `Occurrence` row carries the
 * override alone. Copying its raw fields over would replace a resolved value with a partial one.
 */
function occurrenceFrom(data: unknown): { status: AgendaItemStatus } | undefined {
  if (typeof data !== 'object' || data === null || !('occurrence' in data))
    return undefined;
  const value = (data as { occurrence: unknown }).occurrence;
  if (typeof value !== 'object' || value === null || !('status' in value))
    return undefined;
  const status = (value as { status: unknown }).status;
  /**
   * **Mapped the way the server's own projection maps it**, not copied. A stored `Occurrence`
   * says `completed`/`skipped`; the detail projection says `completed_occurrence`/
   * `skipped_occurrence`, which is what tells a reader the resolution belongs to the day rather
   * than to the series. A raw value written here would be a second, subtly different vocabulary
   * in the cache. `snoozed` and `rescheduled` are not resolutions and leave the status alone.
   */
  if (status === 'completed') return { status: 'completed_occurrence' };
  if (status === 'skipped') return { status: 'skipped_occurrence' };
  return undefined;
}

/** The outcome a completion response reports, when it reports one. */
function outcomeFrom(data: unknown): ActivityOutcome | undefined {
  if (typeof data !== 'object' || data === null || !('outcome' in data)) return undefined;
  const outcome = (data as { outcome: unknown }).outcome;
  return typeof outcome === 'string' ? (outcome as ActivityOutcome) : undefined;
}

/** The two outcomes that mean the thing did not take place, and so store as a skip. */
function isNegativeOutcome(outcome: ActivityOutcome | undefined): boolean {
  return outcome === 'didnt_happen' || outcome === 'didnt_go';
}

function activityFrom(data: unknown): Activity | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const candidate = 'activity' in data ? (data as { activity: unknown }).activity : data;
  if (typeof candidate !== 'object' || candidate === null) return undefined;
  return 'activityId' in candidate ? (candidate as Activity) : undefined;
}

function agendaClock(client: QueryClient): AgendaProjectionClock {
  const timezone = resolveAgendaTimezone(client);
  const now = new Date().toISOString() as Instant;
  return {
    today: toWallDate(now, timezone),
    currentMinute: toWallTime(now, timezone),
  };
}

function update(client: QueryClient, project: (agenda: AgendaData) => AgendaData): void {
  client.setQueriesData<AgendaData>({ queryKey: AGENDA_KEY }, (agenda) =>
    agenda === undefined ? agenda : project(agenda),
  );
}
