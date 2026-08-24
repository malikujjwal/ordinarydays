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
  RankRepairAlreadyStartedError,
  RankRepairContendedError,
  type RankRepairWork,
  snapshotRankRepair,
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

/**
 * Completes the snapshot if it is still outstanding, runs bounded chunks, then commits the
 * final transaction when the snapshot is exhausted.
 */
async function drainFrom(seed: RankRepairWork, now: string): Promise<boolean> {
  const { listId, operationId } = seed;

  for (let chunk = 0; chunk < MAX_DRAIN_CHUNKS; chunk += 1) {
    /**
     * The **stored** cursor, re-read every pass. Two requests can drain one operation —
     * one provoked by a blocked write, one by a fenced read — and applying a slice from a
     * stale cursor would rewrite rows the other has already moved. Re-reading makes them
     * cooperate: whoever is behind simply continues from where the list actually is.
     */
    const stored = await getRankRepairWork(listId, operationId);
    if (stored === undefined) return true;

    // Still `snapshotting` means the installer never filled it — a crash, or a lost race.
    // Finishing it here is what stops a marker with no work gating the list permanently.
    let current: RankRepairWork;
    try {
      current = await snapshotRankRepair(stored, now);
    } catch (error) {
      if (error instanceof RankRepairContendedError) continue;
      throw error;
    }

    if (current.cursor >= current.entries.length) return finishOnce(current);

    try {
      await applyRankRepairChunk(current);
    } catch (error) {
      if (error instanceof RankRepairContendedError) continue;
      throw error;
    }
  }

  const remaining = await getRankRepairWork(listId, operationId);
  if (remaining === undefined) return true;
  if (remaining.cursor < remaining.entries.length) return false;
  return finishOnce(remaining);
}

/**
 * Commits the final transaction, tolerating a concurrent drain that got there first.
 *
 * The condition names this operation id, so a second finisher fails it — and that failure
 * means the repair is **done**, not that anything went wrong. Anything else rethrows.
 */
async function finishOnce(work: RankRepairWork): Promise<boolean> {
  try {
    await finishRankRepair(work);
    return true;
  } catch (error) {
    const current = await getRankRepairWork(work.listId, work.operationId);
    if (current === undefined) return true;
    throw error;
  }
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
  now: string,
): Promise<boolean> {
  const list = await getListMeta(userId, listId, access);
  if (list === undefined) return true;
  const operationId = list.rankRepairId;
  if (operationId === undefined) return true;

  const work = await getRankRepairWork(listId, operationId);
  if (work === undefined) {
    /**
     * The marker and its work row are installed in **one transaction** and cleared in
     * another, so at every committed boundary they agree — including mid-snapshot, which is
     * what the `snapshotting` state is for. A missing record therefore means one of two
     * things: a concurrent drain finished and cleared both between the two reads above, or
     * the record was removed out of band. Re-reading META separates them, because
     * continuing on a snapshot nobody has would rewrite ranks from nothing.
     */
    const after = await getListMeta(userId, listId, access);
    if (after?.rankRepairId === undefined) return true;
    throw new AppError('internal', 'An unexpected error occurred.', [
      { path: 'rankRepairId', message: MARKER_WITHOUT_WORK },
    ]);
  }
  return drainFrom(work, now);
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
  if (list.rankRepairId !== undefined) {
    return drainRankRepair(userId, listId, access, now);
  }

  try {
    const work = await beginRankRepair(userId, listId, access, {
      operationId: newListOperationId(),
      now,
    });
    return await drainFrom(work, now);
  } catch (error) {
    /**
     * Another caller installed the marker between the read above and this write. The loser
     * sees that two ways depending on how far it got — the fence assertion on its own META
     * read, or the conditional install losing — and both mean the same thing: drain the
     * winner's work. There is never a second snapshot of one list.
     *
     * A behaviour-migration marker is **not** ours to finish (P3-09 owns it), so the marker
     * is re-read and anything but a rank repair rethrows as the retryable fence.
     */
    const contended =
      error instanceof RankRepairAlreadyStartedError ||
      error instanceof ListReadFenceError;
    if (!contended) throw error;
    const current = await getListMeta(userId, listId, access);
    if (current?.rankRepairId === undefined) throw error;
    return drainRankRepair(userId, listId, access, now);
  }
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
  now: string = new Date().toISOString(),
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (!(error instanceof ListReadFenceError)) throw error;
    const cleared = await drainRankRepair(userId, listId, access, now);
    if (!cleared) throw error;
    return read();
  }
}
