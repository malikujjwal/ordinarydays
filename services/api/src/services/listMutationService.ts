import { UNDO_OFFER_SECONDS } from '@od/shared';
import { instant, type PatchListInput } from '@od/shared/schemas';
import type { List, ListFeatureConfig } from '@od/shared/types';
import { AppError } from '../lib/errors.js';
import type { IdempotencyReceipt } from '../lib/idempotency.js';
import { hashUndoToken, mintUndoToken } from '../lib/undoToken.js';
import { writeReceiptOnly } from '../repositories/idempotencyRepository.js';
import {
  getListMeta,
  type ListAccessGrant,
  type ListMetaPatch,
  ListNotFoundError,
  ListReadFenceError,
  type ListSettingsUndo,
  newListOperationId,
  patchListMeta,
  type RemovedListDefault,
} from '../repositories/listRepository.js';
import { assertActivityAccess, assertListAccess, type ListAccess } from './authz.js';
import { drainRankRepair } from './listRankRepairService.js';
import { profileDefaultToClear } from './listSlotService.js';

export interface ListSettingsResult {
  readonly list: List;
  readonly undo?: { readonly token: string; readonly expiresAt: string };
}

const LIST_NOT_FOUND = 'List not found.';
const MEMBER_CANNOT = 'Only the list owner can make this change.';
const NOTHING_TO_CHANGE = 'This update changes nothing.';
const STALE = 'This changed while you were editing it. Review the update.';
const NOT_A_PLAN = 'A list can only be added to a plan.';
const ALREADY_CONNECTED = 'This list is already connected to another plan.';

function staleEdit(currentUpdatedAt: string): AppError {
  return new AppError('conflict', STALE, [
    { path: 'updatedAt', message: currentUpdatedAt },
  ]);
}

function hasSameSerializedShape(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function requireList(
  userId: string,
  listId: string,
  access: ListAccessGrant,
): Promise<List> {
  const list = await getListMeta(userId, listId, access);
  if (list === undefined) throw new AppError('not_found', LIST_NOT_FOUND);
  return list;
}

/** Drains the only exceptional public-list work: rank repair. */
export async function drainListWork(
  userId: string,
  listId: string,
  access: ListAccessGrant,
  now: string,
): Promise<boolean> {
  const list = await getListMeta(userId, listId, access);
  if (list === undefined || list.rankRepairId === undefined) return true;
  return drainRankRepair(userId, listId, access, now);
}

export async function withListWorkDrain<T>(
  userId: string,
  listId: string,
  access: ListAccessGrant,
  read: () => Promise<T>,
  now: string,
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (!(error instanceof ListReadFenceError)) throw error;
    if (!(await drainListWork(userId, listId, access, now))) throw error;
    return read();
  }
}

function assertMayPatch(access: ListAccess, input: PatchListInput): void {
  if (access.isOwner) return;
  const restricted = (
    ['itemStateMode', 'featureConfig', 'slot', 'archived', 'sourceActivityId'] as const
  ).filter((field) => field in input);
  if (restricted.length === 0) return;
  throw new AppError(
    'forbidden',
    MEMBER_CANNOT,
    restricted.map((field) => ({ path: field, message: MEMBER_CANNOT })),
  );
}

export async function patchListSettings(
  userId: string,
  listId: string,
  input: PatchListInput,
  ifMatch: string,
  now: string,
  options: {
    readonly receiptFor?: (result: ListSettingsResult) => IdempotencyReceipt;
  } = {},
): Promise<ListSettingsResult> {
  const access = await assertListAccess(userId, listId, 'write');
  assertMayPatch(access, input);
  if (Object.keys(input).length === 0) {
    throw new AppError('validation_failed', NOTHING_TO_CHANGE, [
      { path: 'title', message: NOTHING_TO_CHANGE },
    ]);
  }

  const list = await requireList(userId, listId, access.index);
  if (list.updatedAt !== ifMatch) throw staleEdit(list.updatedAt);

  if (input.sourceActivityId !== undefined) {
    if (
      list.sourceActivityId !== undefined &&
      list.sourceActivityId !== input.sourceActivityId
    ) {
      throw new AppError('conflict', ALREADY_CONNECTED, [
        { path: 'sourceActivityId', message: ALREADY_CONNECTED },
      ]);
    }
    const { activity } = await assertActivityAccess(
      userId,
      input.sourceActivityId,
      'owner',
    );
    if (activity.objectKind !== 'plan') {
      throw new AppError('validation_failed', NOT_A_PLAN, [
        { path: 'sourceActivityId', message: NOT_A_PLAN },
      ]);
    }
  }

  const featureConfig: ListFeatureConfig =
    input.featureConfig === undefined
      ? list.featureConfig
      : ({ ...list.featureConfig, ...input.featureConfig } as ListFeatureConfig);
  const changed: ListMetaPatch = {
    ...(input.title !== undefined && input.title !== list.title
      ? { title: input.title }
      : {}),
    ...(input.itemStateMode !== undefined &&
    !hasSameSerializedShape(input.itemStateMode, list.itemStateMode)
      ? { itemStateMode: input.itemStateMode }
      : {}),
    ...(input.featureConfig !== undefined &&
    !hasSameSerializedShape(featureConfig, list.featureConfig)
      ? { featureConfig }
      : {}),
    ...('slot' in input && input.slot !== undefined && input.slot !== list.slot
      ? { slot: input.slot }
      : {}),
    ...(input.archived !== undefined && input.archived !== list.archived
      ? { archived: input.archived }
      : {}),
    ...(input.sourceActivityId !== undefined &&
    input.sourceActivityId !== list.sourceActivityId
      ? { sourceActivityId: input.sourceActivityId }
      : {}),
  };
  if (Object.keys(changed).length === 0) {
    const result: ListSettingsResult = { list };
    if (options.receiptFor !== undefined) {
      await writeReceiptOnly(options.receiptFor(result));
    }
    return result;
  }

  const clearsDefault = 'slot' in changed ? profileDefaultToClear(list) : undefined;
  const reversible = input.sourceActivityId === undefined;
  let undo: ListSettingsResult['undo'];
  let undoFor: ((removedDefault?: RemovedListDefault) => ListSettingsUndo) | undefined;
  if (reversible) {
    const operationId = newListOperationId();
    const { token } = mintUndoToken(operationId);
    const expiresAt = instant.parse(
      new Date(Date.parse(now) + UNDO_OFFER_SECONDS * 1000).toISOString(),
    );
    undo = { token, expiresAt };
    undoFor = (removedDefault) => ({
      operationId,
      kind: 'settings',
      tokenHash: hashUndoToken(token),
      undoExpiresAt: expiresAt,
      inverse: {
        ...('title' in changed ? { title: list.title } : {}),
        ...('itemStateMode' in changed ? { itemStateMode: list.itemStateMode } : {}),
        ...('featureConfig' in changed ? { featureConfig: list.featureConfig } : {}),
        ...('slot' in changed ? { slot: list.slot } : {}),
        ...('archived' in changed ? { archived: list.archived } : {}),
        ...(removedDefault === undefined ? {} : { removedDefault }),
      },
      preconditions: {
        ...('title' in changed ? { title: changed.title } : {}),
        ...('itemStateMode' in changed ? { itemStateMode: changed.itemStateMode } : {}),
        ...('featureConfig' in changed ? { featureConfig: changed.featureConfig } : {}),
        ...('slot' in changed ? { slot: changed.slot ?? null } : {}),
        ...('archived' in changed ? { archived: changed.archived } : {}),
        ...(removedDefault === undefined
          ? {}
          : { defaultSlotAbsent: removedDefault.slot }),
      },
    });
  }

  const result: ListSettingsResult = {
    list: { ...list, ...changed, updatedAt: instant.parse(now) },
    ...(undo === undefined ? {} : { undo }),
  };

  try {
    await patchListMeta(userId, listId, access.index, changed, list.updatedAt, now, {
      ...(clearsDefault === undefined ? {} : { clearProfileDefault: clearsDefault }),
      ...(undoFor === undefined ? {} : { undoFor }),
      ...(input.sourceActivityId === undefined
        ? {}
        : { sourceActivityId: input.sourceActivityId }),
      ...(options.receiptFor === undefined
        ? {}
        : { idempotencyReceipt: options.receiptFor(result) }),
    });
  } catch (error) {
    if (error instanceof ListNotFoundError) {
      throw new AppError('not_found', LIST_NOT_FOUND);
    }
    if (!(error instanceof AppError) || error.code !== 'conflict') throw error;
    const fresh = await getListMeta(userId, listId, access.index);
    if (fresh === undefined) throw new AppError('not_found', LIST_NOT_FOUND);
    throw staleEdit(fresh.updatedAt);
  }

  return result;
}
