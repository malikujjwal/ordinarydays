import { AppError } from '../lib/errors.js';
import {
  applyRankRepairChunk,
  beginRankRepair,
  finishRankRepair,
  getListMeta,
  getRankRepairWork,
  type ListAccessGrant,
  ListNotFoundError,
  ListReadFenceError,
  newListOperationId,
  type RankRepairWork,
} from '../repositories/listRepository.js';

/**
 * The exceptional list-rank repair worker (§P3-03, `data-model.md` §7 "Repair list ranks").
 *
 * ## What this is for, and what it is not
 *
 * It runs when rank allocation finds neighbours it cannot subdivide: an equal-rank run left
 * by an Undo restoration, a legacy or seeded row, or a bounded gap subdivided until no rank
 * of 64 characters fits. Both arrive as `ListRankRepairRequiredError` from the repository,
 * which never calls `lexoRankBetween` with equal bounds.
 *
 * **This is not the drag path's permission to renumber a list.** An ordinary reorder writes
 * one logical item (acceptance criterion 16). Repair rewrites many, and every read and
 * mutation on the list is refused while it does.
 *
 * ## Bounded, resumable, and never mid-generation
 *
 * A caller gets a bounded number of chunks per request. If work remains the caller answers
 * `503` with `Retry-After: 1` and the next request continues from the stored cursor — a
 * crash resumes the same way, because each chunk commits its cursor advance in the
 * transaction that does its work. No item page is ever served while the marker stands, so a
 * client cannot observe a half-repaired list, and the final transaction advances
 * `rankVersion` so cursors issued before the repair are rejected rather than resumed across
 * changed sort keys.
 */

/**
 * Chunks one request will run before giving the client a `503` and continuing next time.
 *
 * Eight chunks is 200 items — enough that a list at the 500-item cap repairs in three
 * requests, and few enough that one request cannot spend its whole Lambda budget here.
 */
const MAX_DRAIN_CHUNKS = 8;

const MARKER_WITHOUT_WORK =
  'A list repair marker names no work record; the repair cannot be resumed.';

/** Runs bounded chunks, then commits the final transaction when the snapshot is exhausted. */
async function drainFrom(work: RankRepairWork): Promise<boolean> {
  let current = work;
  for (
    let chunk = 0;
    chunk < MAX_DRAIN_CHUNKS && current.cursor < current.entries.length;
    chunk += 1
  ) {
    current = await applyRankRepairChunk(current);
  }
  if (current.cursor < current.entries.length) return false;
  await finishRankRepair(current);
  return true;
}

/**
 * Advances an **already-installed** repair, and reports whether the list is clear.
 *
 * `false` means work remains and the caller must answer the retryable `503`. It is also
 * `true` when no marker stands at all, so a fence failure caused by something else — a
 * racing reorder changing `rankVersion` between a page's two META reads — falls straight
 * through to that same `503` without pretending to have repaired anything.
 */
export async function drainRankRepair(
  userId: string,
  listId: string,
  access: ListAccessGrant,
): Promise<boolean> {
  const list = await getListMeta(userId, listId, access);
  if (list === undefined) return true;
  const operationId = list.rankRepairId;
  if (operationId === undefined) return true;

  const work = await getRankRepairWork(listId, operationId);
  // The marker and its work row are installed in one transaction and cleared in another, so
  // at every committed boundary they agree. A marker alone means the record was removed out
  // of band, and continuing would rewrite ranks from a snapshot nobody has.
  if (work === undefined) {
    throw new AppError('internal', 'An unexpected error occurred.', [
      { path: 'rankRepairId', message: MARKER_WITHOUT_WORK },
    ]);
  }
  return drainFrom(work);
}

/**
 * Repairs the list's ranks, installing the marker when none stands yet.
 *
 * Returns `false` when the repair is still incomplete after its bounded work, which the
 * caller turns into the retryable `503` rather than retrying the mutation that provoked it.
 * A concurrent caller that lost the conditional marker install simply drains the winner's
 * work; there is never a second snapshot of the same list.
 */
export async function repairListRanks(
  userId: string,
  listId: string,
  access: ListAccessGrant,
  now: string,
): Promise<boolean> {
  const list = await getListMeta(userId, listId, access);
  if (list === undefined) throw new ListNotFoundError();
  if (list.rankRepairId !== undefined) return drainRankRepair(userId, listId, access);

  const work = await beginRankRepair(userId, listId, access, {
    operationId: newListOperationId(),
    now,
  });
  return drainFrom(work);
}

/**
 * Runs a fenced read, draining a standing repair once before giving up.
 *
 * Pattern 8's fence throws for two different reasons and this handles both correctly: a
 * repair or migration marker, which a drain may clear, and a `rankVersion` that moved
 * between the two META reads, which it cannot. In the second case the drain reports "clear"
 * immediately, the retried read fails the same way, and the caller gets the `503` that tells
 * the client to restart at page one.
 */
export async function withRepairDrain<T>(
  userId: string,
  listId: string,
  access: ListAccessGrant,
  read: () => Promise<T>,
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (!(error instanceof ListReadFenceError)) throw error;
    const cleared = await drainRankRepair(userId, listId, access);
    if (!cleared) throw error;
    return read();
  }
}
