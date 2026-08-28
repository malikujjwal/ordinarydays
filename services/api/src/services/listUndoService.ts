import { instant } from '@od/shared/schemas';
import type { ListUndoResult } from '@od/shared/types';
import { AppError } from '../lib/errors.js';
import type { IdempotencyReceipt } from '../lib/idempotency.js';
import { undoTokenMatches, undoTokenOperationId } from '../lib/undoToken.js';
import {
  acceptListUndoOperation,
  applyListSettingsInverse,
  consumeListUndoOperation,
  getListUndoOperation,
  ListNotFoundError,
  ListUndoNotApplicableError,
  type ListUndoOperation,
  restoreDoneStates,
  restoreListItems,
} from '../repositories/listRepository.js';
import { assertListAccess } from './authz.js';

type ReceiptFor = (affectedCount: number) => IdempotencyReceipt;
const EXPIRED: ListUndoResult = { outcome: 'expired' };
const NOT_APPLICABLE: ListUndoResult = { outcome: 'no_longer_applicable' };
const LIST_NOT_FOUND = 'List not found.';

function withinRetention(operation: ListUndoOperation, now: string): boolean {
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new Error('Undo received an invalid now.');
  return operation.ttl * 1000 > nowMs;
}

export async function undoListOperation(
  userId: string,
  listId: string,
  undoToken: string,
  now: string,
  receiptFor: ReceiptFor,
): Promise<ListUndoResult> {
  const acceptedRequestAt = instant.parse(now);
  const access = await assertListAccess(userId, listId, 'write');
  const operationId = undoTokenOperationId(undoToken);
  if (operationId === undefined) return EXPIRED;

  const operation = await getListUndoOperation(userId, listId, access.index, operationId);
  if (
    operation === undefined ||
    !undoTokenMatches(undoToken, operation.tokenHash) ||
    !withinRetention(operation, acceptedRequestAt)
  )
    return EXPIRED;
  if (operation.consumed) return NOT_APPLICABLE;

  try {
    if (operation.kind === 'settings') {
      await applyListSettingsInverse(
        userId,
        listId,
        access.index,
        operation.inverse ?? {},
        operation.preconditions ?? {},
        { operationId, now: acceptedRequestAt, receiptFor },
      );
      return { outcome: 'applied', affectedCount: 1 };
    }

    const acceptance = await acceptListUndoOperation(
      userId,
      listId,
      access.index,
      operationId,
      acceptedRequestAt,
    );
    const compensate = {
      operationId,
      now: acceptance.acceptedAt,
      previouslyAffectedCount: acceptance.completedCount,
      receiptFor,
    };

    if (operation.kind === 'reopen_done') {
      const affectedCount = await restoreDoneStates(
        userId,
        listId,
        access.index,
        operation.affectedItemIds,
        compensate,
      );
      return { outcome: 'applied', affectedCount };
    }
    if (operation.affectedItemIds.length === 0) {
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
    return {
      outcome: 'applied',
      affectedCount: acceptance.completedCount + restored.length,
    };
  } catch (error) {
    if (error instanceof ListUndoNotApplicableError) return NOT_APPLICABLE;
    if (error instanceof ListNotFoundError)
      throw new AppError('not_found', LIST_NOT_FOUND);
    throw error;
  }
}
