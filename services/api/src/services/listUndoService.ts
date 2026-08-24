import type { ListItemDetails, ListUndoResult } from '@od/shared/types';
import { AppError } from '../lib/errors.js';
import type { IdempotencyReceipt } from '../lib/idempotency.js';
import { undoTokenMatches, undoTokenOperationId } from '../lib/undoToken.js';
import {
  applyListSettingsInverse,
  consumeListUndoOperation,
  getListMeta,
  getListUndoOperation,
  type ListAccessGrant,
  ListNotFoundError,
  type ListSettingsInverse,
  type ListSettingsPreconditions,
  ListUndoNotApplicableError,
  type ListUndoOperation,
  readAllListItems,
  recheckListItems,
  restoreListItems,
} from '../repositories/listRepository.js';
import { assertListAccess } from './authz.js';
import { undoBehaviourUpgrade } from './listMutationService.js';

/**
 * `POST /v1/lists/:id/undo` — the one compensation endpoint (§P3-10, `api-contract.md` §2.7).
 *
 * ## The two deadlines, which are not the same deadline
 *
 * This is the rule the whole file is arranged around, and the one the risk register says gets
 * got wrong: **`undoExpiresAt` governs whether a client may still OFFER a new Undo. It never
 * governs whether an accepted inverse may run.** A user who taps Undo inside the toast has
 * made their decision; the intent then becomes durable on the device and may reach the server
 * minutes or days later, after an app close or a flight. Refusing it for crossing a
 * presentation deadline would discard a decision the product told the user it had taken.
 *
 * So the only expiry consulted here is the operation's **replay retention** —
 * `MAX_AUTOMATIC_INTENT_AGE_DAYS`, the same window the durable outbox and the item tombstones
 * keep, so an accepted offline inverse cannot expire in transit. `undoExpiresAt` is not read
 * by this service at all, which is the clearest way to be sure it never leaks into the
 * decision.
 *
 * ## Why nothing here is an error code
 *
 * Three outcomes, one status. A token that names nothing, a token whose hash does not match
 * and a token past retention are **all** `expired`, deliberately indistinguishable: telling a
 * caller that their token is well-formed but stale would tell them something about an
 * operation they may not own. An operation that is retained and correctly addressed but has
 * already been used — or whose recorded preconditions have moved — is
 * `no_longer_applicable`. Neither is a failed request, so neither is an `ErrorCode`; the
 * server was asked what happened to a compensation and answers exactly that.
 *
 * ## This is the only route past a tombstone
 *
 * `ITEM_TOMBSTONE#` refuses ordinary creation for the whole replay window, which is what stops
 * a delayed offline create resurrecting deleted data. Restoration earns its exception by
 * naming the operation: every tombstone it removes must carry the same `operationId`, so one
 * delete's token can never reclaim another delete's ids.
 */

/** Builds the response receipt from the count the compensation really applied. */
type ReceiptFor = (affectedCount: number) => IdempotencyReceipt;

const EXPIRED: ListUndoResult = { outcome: 'expired' };
const NOT_APPLICABLE: ListUndoResult = { outcome: 'no_longer_applicable' };
const LIST_NOT_FOUND = 'List not found.';

/**
 * Whether the operation is still inside its replay retention.
 *
 * Checked against the stored `ttl` rather than trusting DynamoDB to have removed the row:
 * TTL deletion is lazy — typically within 48 hours, with no guarantee — so an expired record
 * is very often still readable, and treating "present" as "valid" would quietly extend the
 * retention by however long the sweeper took.
 */
function withinRetention(operation: ListUndoOperation, now: string): boolean {
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new Error('Undo received an invalid now.');
  return operation.ttl * 1000 > nowMs;
}

/**
 * Every affected item still carries exactly the `details` the upgrade created.
 *
 * §P3-09 records that value as the operation's precondition, and §P3-10 spends it here: the
 * behaviour-upgrade inverse "removes only unchanged upgrade defaults", so an item somebody has
 * since given a season and episode makes the whole compensation no longer applicable rather
 * than quietly taking their edit with it.
 */
async function upgradeDefaultsUntouched(
  userId: string,
  listId: string,
  access: ListAccessGrant,
  affectedItemIds: readonly string[],
  expected: ListItemDetails | undefined,
): Promise<boolean> {
  const wanted = new Set(affectedItemIds);
  const items = (await readAllListItems(userId, listId, access)).filter((item) =>
    wanted.has(item.itemId),
  );
  return items.every(
    (item) => JSON.stringify(item.details ?? null) === JSON.stringify(expected ?? null),
  );
}

async function applySettings(
  userId: string,
  listId: string,
  access: ListAccessGrant,
  operation: ListUndoOperation,
  now: string,
  receiptFor: ReceiptFor,
): Promise<ListUndoResult> {
  const inverse: ListSettingsInverse = operation.inverse ?? {};
  const preconditions: ListSettingsPreconditions = operation.preconditions ?? {};
  await applyListSettingsInverse(userId, listId, access, inverse, preconditions, {
    operationId: operation.operationId,
    now,
    receiptFor,
  });
  return { outcome: 'applied', affectedCount: 1 };
}

/**
 * Undoes a behaviour upgrade through the migration protocol that made it (§P3-09).
 *
 * Not an ordinary downgrade, and the difference is the whole point: this one restores
 * `collection` **without** `confirmDataLoss`, because it is not asking the user to agree to a
 * loss — it is taking back defaults nobody has touched. The preconditions above are what earn
 * that exemption, so they are checked before the migration starts rather than being folded
 * into it.
 */
async function applyBehaviourUpgrade(
  userId: string,
  listId: string,
  access: ListAccessGrant,
  operation: ListUndoOperation,
  now: string,
  receiptFor: ReceiptFor,
): Promise<ListUndoResult> {
  const inverse = operation.inverse ?? {};
  const preconditions = operation.preconditions ?? {};
  const list = await getListMeta(userId, listId, access);
  if (list === undefined) throw new AppError('not_found', LIST_NOT_FOUND);
  if (
    inverse.behaviour === undefined ||
    (preconditions.behaviour !== undefined && list.behaviour !== preconditions.behaviour)
  ) {
    return NOT_APPLICABLE;
  }
  const untouched = await upgradeDefaultsUntouched(
    userId,
    listId,
    access,
    inverse.affectedItemIds ?? [],
    preconditions.itemDetails,
  );
  if (!untouched) return NOT_APPLICABLE;

  /**
   * The count is what the operation **recorded**, not what the migration happens to walk: the
   * inverse names the items the upgrade created defaults on, so the receipt can be built
   * before the migration starts rather than after its snapshot decides.
   */
  const affectedCount = (inverse.affectedItemIds ?? []).length;
  await undoBehaviourUpgrade(userId, listId, access, {
    operationId: operation.operationId,
    toBehaviour: inverse.behaviour,
    ...(inverse.restoreDetails === undefined
      ? {}
      : { toDetails: inverse.restoreDetails }),
    expectedUpdatedAt: list.updatedAt,
    now,
    receipt: receiptFor(affectedCount),
  });
  await consumeListUndoOperation(userId, listId, access, {
    operationId: operation.operationId,
    now,
  });
  return { outcome: 'applied', affectedCount };
}

/**
 * Applies the compensation one retained token addresses, or says why it did not.
 *
 * The dispatch is on the operation's recorded `kind`, never on anything the request carries:
 * a client hands back a token and the server decides what that token means, which is the
 * whole reason the contract forbids sending deleted row contents back as authority.
 */
export async function undoListOperation(
  userId: string,
  listId: string,
  undoToken: string,
  now: string,
  receiptFor: ReceiptFor,
): Promise<ListUndoResult> {
  const access = await assertListAccess(userId, listId, 'write');
  const operationId = undoTokenOperationId(undoToken);
  if (operationId === undefined) return EXPIRED;

  const operation = await getListUndoOperation(userId, listId, access.index, operationId);
  if (operation === undefined) return EXPIRED;
  if (!undoTokenMatches(undoToken, operation.tokenHash)) return EXPIRED;
  if (!withinRetention(operation, now)) return EXPIRED;
  // Single use, and the storage condition below is the enforcement; this is the early answer.
  if (operation.consumed) return NOT_APPLICABLE;

  const compensate = { operationId: operation.operationId, now, receiptFor };

  try {
    if (operation.kind === 'settings') {
      return await applySettings(
        userId,
        listId,
        access.index,
        operation,
        now,
        receiptFor,
      );
    }
    if (operation.kind === 'behaviour_upgrade') {
      return await applyBehaviourUpgrade(
        userId,
        listId,
        access.index,
        operation,
        now,
        receiptFor,
      );
    }
    if (operation.kind === 'uncheck_all') {
      const rechecked = await recheckListItems(
        userId,
        listId,
        access.index,
        operation.affectedItemIds,
        compensate,
      );
      return { outcome: 'applied', affectedCount: rechecked };
    }
    if (operation.affectedItemIds.length === 0) {
      // A `clear-checked` that found nothing checked. Spending it keeps the token single-use.
      await consumeListUndoOperation(userId, listId, access.index, compensate);
      return { outcome: 'applied', affectedCount: 0 };
    }
    const restored = await restoreListItems(
      userId,
      listId,
      access.index,
      operation.affectedItemIds,
      compensate,
    );
    return { outcome: 'applied', affectedCount: restored.length };
  } catch (error) {
    /**
     * The conditions this compensation ran under have moved. Every one of them is a
     * precondition the operation recorded — a tombstone that is gone, a setting somebody
     * edited, an operation a concurrent replay spent — and none is a failure of the request,
     * so all of them answer the same typed outcome and write nothing.
     */
    if (error instanceof ListUndoNotApplicableError) return NOT_APPLICABLE;
    if (error instanceof ListNotFoundError)
      throw new AppError('not_found', LIST_NOT_FOUND);
    throw error;
  }
}
