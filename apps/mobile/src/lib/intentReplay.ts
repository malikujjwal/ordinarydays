import type { HttpClient } from '@od/shared/client';
import type { QueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/apiClient';
import { recoverFromCollision } from '@/lib/collisionRecovery';
import type { Intent, IntentLog } from '@/lib/intentLog';

/**
 * The bridge from the durable log to TanStack's execution machinery.
 *
 * ADR-055 keeps TanStack as "the execution and retry machinery" while taking away its role as
 * the durability boundary. That split needs exactly one thing that this module provides: on
 * cold start the log is authoritative and pending work is **rebuilt** from it, rather than
 * rehydrated from a mutation cache that may have been pruned.
 *
 * It covers mutations that were `in_flight` when the process died, not merely paused ones.
 * TanStack only ever persisted `isPaused` mutations, so a write killed mid-request was
 * previously lost outright — the user saw it applied, and nothing ever sent it.
 */

/** Kept deliberately narrow: replay needs to build and run a mutation, nothing more. */
type MutationRunner = Pick<QueryClient, 'getMutationCache' | 'getMutationDefaults'>;

/**
 * The log the `MutationCache` writes through, or `undefined` when there is none.
 *
 * A module-level registry rather than a parameter because the write-ahead seam is
 * `MutationCache.onMutate`, which TanStack calls with no injection point of its own. Absent is
 * a meaningful value and does the platform rule for free: the log is registered only on iOS
 * (ADR-024), so on web every mutation runs exactly as it did before, with no queue.
 *
 * Sign-out clears it, which is what stops a second account's writes reaching the first
 * account's log (`auth.md` §3.4 step 6).
 */
let activeLog: IntentLog | undefined;

export function setActiveIntentLog(log: IntentLog | undefined): void {
  activeLog = log;
}

export function getActiveIntentLog(): IntentLog | undefined {
  return activeLog;
}

/**
 * The intent currently being replayed, if any.
 *
 * Replay runs a mutation through the same client whose `MutationCache` appends intents, so
 * without this a replay would append a *second* copy of the intent it is replaying and the
 * queue would grow every time it drained. Safe as module state because replay is serial and
 * JavaScript is single-threaded — `replayIntents` awaits each dispatch before the next.
 */
let replayingIntentId: string | undefined;

export function replayingIntent(): string | undefined {
  return replayingIntentId;
}

export interface ReplayResult {
  attempted: number;
  acknowledged: number;
  requeued: number;
  failed: number;
  /** Collisions resolved by reading the client's own id, needing no user involvement. */
  recovered: number;
  /** Parked for the user: a collision whose recovery read came back `404`. */
  parked: number;
}

/**
 * A create whose id the server refused (P2-49).
 *
 * The only failure with a recovery path of its own, because it is the only one where the
 * client already knows the entity's permanent id and can simply go and look.
 */
function isCreateCollision(intent: Intent, error: unknown): boolean {
  if (intent.mutationKey[1] !== 'create') return false;
  return (error as { status?: unknown } | undefined)?.status === 409;
}

function createdActivityId(intent: Intent): string | undefined {
  const input = (intent.variables as { input?: { activityId?: unknown } } | undefined)
    ?.input;
  return typeof input?.activityId === 'string' ? input.activityId : undefined;
}

/**
 * A rejection the server will give the same answer to no matter how often it is retried.
 *
 * Everything else — no connectivity, a 5xx, a timeout — returns the intent to `queued`, which
 * is the difference between "this will never work" and "not right now". Only the first is
 * allowed to consume a user's write.
 */
function isPermanent(error: unknown): boolean {
  const status = (error as { status?: unknown } | undefined)?.status;
  if (typeof status !== 'number') return false;
  if (status === 408 || status === 429) return false;
  return status >= 400 && status < 500;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs every automatable intent, oldest first.
 *
 * **Serially, and that is deliberate.** FIFO per entity is a promise (`tech-stack.md` §3.4),
 * and two edits to one row dispatched concurrently can arrive in either order. Running the
 * whole pass in `seq` order keeps the promise without needing per-entity bookkeeping, at the
 * cost of latency that a queue drained on reconnect can afford.
 *
 * A mid-pass failure does not abort the rest: an unrelated entity should not be held hostage
 * by one rejected write, which is the same reason no cross-entity ordering is promised.
 */
export async function replayIntents(
  client: MutationRunner,
  log: IntentLog,
  http: HttpClient = apiClient,
): Promise<ReplayResult> {
  await log.refreshClockRule();
  const result: ReplayResult = {
    attempted: 0,
    acknowledged: 0,
    requeued: 0,
    failed: 0,
    recovered: 0,
    parked: 0,
  };

  for (const intent of log.replayable()) {
    /**
     * `markInFlight` is the race gate against `cancel`. Both go through the log's serialised
     * write chain, so if a cancel landed first this intent is already gone and the transition
     * returns `undefined` — the race loser is a no-op, never a second write.
     */
    const claimed = await log.markInFlight(intent.intentId);
    if (claimed === undefined || claimed.status !== 'in_flight') continue;

    result.attempted += 1;
    try {
      await runIntent(client, claimed);
      await log.acknowledge(claimed.intentId);
      result.acknowledged += 1;
    } catch (error) {
      const collidedId = isCreateCollision(claimed, error)
        ? createdActivityId(claimed)
        : undefined;
      if (collidedId !== undefined) {
        /**
         * The documented recovery: read the client's **own** id. A `200` means the earlier
         * create landed and only its response was lost, so this is a success wearing a
         * conflict's clothes; a `404` needs the user, because a foreign collision and a
         * tombstoned create-then-delete look identical and neither may be re-minted.
         */
        try {
          const outcome = await recoverFromCollision(http, collidedId);
          if (outcome.kind === 'acknowledged') {
            await log.acknowledge(claimed.intentId);
            result.acknowledged += 1;
            result.recovered += 1;
          } else {
            await log.park(claimed.intentId, 'This never synced.');
            result.parked += 1;
          }
        } catch {
          // The recovery read itself failed: no answer, so conclude nothing and keep the write.
          await log.requeue(claimed.intentId, message(error));
          result.requeued += 1;
        }
        continue;
      }
      if (isPermanent(error)) {
        await log.fail(claimed.intentId, message(error));
        result.failed += 1;
      } else {
        await log.requeue(claimed.intentId, message(error));
        result.requeued += 1;
      }
    }
  }
  return result;
}

/**
 * Executes one intent through its registered default.
 *
 * The persisted variables carry the `Idempotency-Key` minted when the action was accepted, so
 * a replay after any delay — including one the server already saw — is deduplicated server
 * side rather than producing a second entity.
 */
export async function runIntent(
  client: MutationRunner,
  intent: Intent,
): Promise<unknown> {
  const key = [...intent.mutationKey];
  const defaults = client.getMutationDefaults(key);
  if (typeof defaults.mutationFn !== 'function') {
    throw new Error(`No mutation default is registered for ${JSON.stringify(key)}.`);
  }
  const mutation = client.getMutationCache().build(client as QueryClient, {
    ...defaults,
    mutationKey: key,
  });
  replayingIntentId = intent.intentId;
  try {
    return await mutation.execute(intent.variables);
  } finally {
    replayingIntentId = undefined;
  }
}
