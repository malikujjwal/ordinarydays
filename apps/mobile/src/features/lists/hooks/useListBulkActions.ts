import {
  ApiError,
  clearCheckedListItems,
  isRetryable,
  NetworkError,
  uncheckAllListItems,
  undoListOperation,
} from '@od/shared/client';
import type { List } from '@od/shared/types';
import { randomUUID } from 'expo-crypto';
import { useCallback } from 'react';
import { useListIndexMutations } from '@/features/lists/hooks/useListIndexMutations';
import { useClock } from '@/hooks/useClock';
import { apiClient } from '@/lib/apiClient';
import { type ToastMessage, useToast } from '@/stores/toast';
import {
  clearedItemsToast,
  remainingBulkUndoMs,
  uncheckedItemsToast,
} from '../model/bulkUndoToast';

/**
 * The list header's two bulk actions, plus archive (§5.6, §P3-10, §P3-27).
 *
 * ## No dialog, and the count is what pays for that
 *
 * `Clear checked` applies immediately with a **10-second** undo toast naming the count. That is
 * §P3-10's recorded decision: clearing is the *end* of a shopping trip, on rows the user has
 * already ticked one at a time, and "a dialog asks them to re-confirm a decision they have
 * already made seven times". The window lives in `bulkUndoToast.ts` so the number cannot be
 * got wrong inline; the menu states the count before the tap.
 *
 * The undo call is **compensating and immediate** (the P2-24 rule): tapping Undo fires
 * `POST /v1/lists/:id/undo` with the server's opaque token straight away, and closing the app
 * without tapping leaves the change committed. Nothing here reconstructs the rows.
 *
 * ## Archive is not one of these
 *
 * It is a settings write with a six-second window and its own durable path, so it is
 * delegated to `useListIndexMutations` rather than re-implemented — the two windows differ on
 * purpose and one screen owning both numbers is how they drift.
 */
export interface ListBulkActions {
  clearDone: (listId: string, lifecycle?: BulkActionLifecycle) => Promise<boolean>;
  uncheckAll: (listId: string, lifecycle?: BulkActionLifecycle) => Promise<boolean>;
  archive: (list: List) => void;
  remove: (list: List) => void;
}

type BulkAction = 'clear-done' | 'uncheck-all';

export interface BulkActionLifecycle {
  readonly onStarted: () => void;
  readonly onRejected: () => void;
}

const BULK_FAILURE_MESSAGES: Record<BulkAction, Record<'forward' | 'undo', string>> = {
  'clear-done': {
    forward: "Couldn't clear checked items.",
    undo: "Couldn't undo clearing checked items.",
  },
  'uncheck-all': {
    forward: "Couldn't uncheck items.",
    undo: "Couldn't undo unchecking items.",
  },
};

function bulkFailureToast(
  error: unknown,
  action: BulkAction,
  phase: 'forward' | 'undo',
  retry: () => void,
): ToastMessage {
  const retryable = isRetryable(error);
  const requestId =
    error instanceof ApiError || error instanceof NetworkError
      ? error.requestId
      : undefined;
  return {
    message:
      error instanceof ApiError && !retryable
        ? error.message
        : BULK_FAILURE_MESSAGES[action][phase],
    tone: 'error',
    ...(requestId === undefined ? {} : { requestId }),
    ...(retryable ? { action: { label: 'Retry', onPress: retry } } : {}),
  };
}

export function useListBulkActions(onChanged: () => void): ListBulkActions {
  const clock = useClock();
  const show = useToast((state) => state.show);
  const showUndo = useToast((state) => state.showUndo);
  const dismiss = useToast((state) => state.dismiss);
  const { onArchive, onDelete } = useListIndexMutations();

  const run = useCallback(
    async (
      listId: string,
      action: BulkAction,
      idempotencyKey: string,
      lifecycle?: BulkActionLifecycle,
    ): Promise<boolean> => {
      lifecycle?.onStarted();
      // The accepted action owns the singleton toast slot before this request can settle.
      dismiss();
      const call = action === 'clear-done' ? clearCheckedListItems : uncheckAllListItems;
      try {
        const result = await call(apiClient, listId, idempotencyKey);
        onChanged();
        if (result.affectedCount > 0) {
          const duration = remainingBulkUndoMs(result.undoExpiresAt, clock);
          if (duration === undefined) return true;
          showUndo(
            (action === 'clear-done' ? clearedItemsToast : uncheckedItemsToast)({
              affectedCount: result.affectedCount,
              duration,
              undoExpiresAt: result.undoExpiresAt,
              onUndo: () => {
                // Undo acceptance creates one replay identity. Every Retry is the same
                // compensation, so it must reuse that key just like the forward action.
                const idempotencyKey = randomUUID();
                const undo = () => {
                  // The first call has already consumed the Undo offer; later calls own the
                  // visible failure toast and must clear it before retrying.
                  dismiss();
                  void undoListOperation(
                    apiClient,
                    listId,
                    result.undoToken,
                    idempotencyKey,
                  )
                    .then(() => onChanged())
                    .catch((error: unknown) =>
                      show(bulkFailureToast(error, action, 'undo', undo)),
                    );
                };
                undo();
              },
              onCommit: () => undefined,
            }),
          );
        }
        return true;
      } catch (error) {
        lifecycle?.onRejected();
        show(
          bulkFailureToast(error, action, 'forward', () => {
            void run(listId, action, idempotencyKey, lifecycle);
          }),
        );
        return false;
      }
    },
    [clock, dismiss, onChanged, show, showUndo],
  );

  return {
    clearDone: (listId, lifecycle) => run(listId, 'clear-done', randomUUID(), lifecycle),
    uncheckAll: (listId, lifecycle) =>
      run(listId, 'uncheck-all', randomUUID(), lifecycle),
    archive: onArchive,
    remove: onDelete,
  };
}
