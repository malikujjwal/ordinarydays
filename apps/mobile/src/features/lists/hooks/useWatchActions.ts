import {
  ApiError,
  isRetryable,
  type PatchListItemInput,
  patchListItem,
} from '@od/shared/client';
import type { CompletionFollowUp } from '@od/shared/schemas';
import type { ListItemView } from '@od/shared/types';
import { useCallback } from 'react';
import { apiClient } from '@/lib/apiClient';
import { type ToastMessage, useToast } from '@/stores/toast';
import {
  followUpItemPatch,
  followUpUndoPatch,
  markWatchedPatch,
  restoreStatusPatch,
} from '../model/watchProgress';
import { markedWatchedToast, watchProgressToast } from '../model/watchUndoToast';

/**
 * The two watch writes, and the six seconds each of them can be taken back in
 * (§P3-31, `plans-and-lists.md` §8.1, §8.4).
 *
 * Both are the **same** shape and deliberately so: one `PATCH /v1/lists/:id/items/:itemId`
 * carrying `details` and nothing else, applied on the tap, with a toast whose `onUndo` sends
 * the previous `details` back. What differs is only which body the model built.
 *
 * ## Online-first, and the seam that changes that
 *
 * This calls `patchListItem` directly, which is what every merged item write on this screen
 * does today — `useReorderItems` and `useListBulkActions` both do. **P3-29 owns the durable
 * item-write path** (`usePatchListItem{,.native}` and the `['list','item-patch']` intent) and
 * has not landed on `main`; when it does, these two calls become that hook and native gains an
 * offline `Mark watched` for free. Named in this PR rather than duplicated here: a second
 * durable path would be the drift the one-mutation-path rule exists to prevent.
 *
 * ## `watching → watched` is never automatic
 *
 * Every write here starts at a tap — the swipe action, or P3-43's confirmed follow-up. Nothing
 * in this file observes a completion, a date or a count and decides a show is finished; §8.1 is
 * explicit that the app cannot know how many episodes there are. The one status the app may
 * offer on evidence is a **movie**'s, and even that arrives as a follow-up the user confirms.
 */
export interface WatchActions {
  /**
   * §3.2's `Mark watched`, from the swipe or the accessibility rotor.
   *
   * A no-op on a row with no typed details: there is no status to change, and inventing one
   * would turn a bad response into a write.
   */
  readonly markWatched: (listId: string, item: ListItemView) => void;
  /**
   * §8.4 step 2, confirmed. **P3-43 calls this**; it does not build the body.
   *
   * The argument is the server's own `followUp` object, handed back untouched. Dismissal never
   * reaches here — it is the absence of a call, not a call that declines.
   */
  readonly confirmFollowUp: (followUp: CompletionFollowUp) => void;
}

function failureToast(error: unknown, message: string, retry: () => void): ToastMessage {
  let displayed = message;
  if (error instanceof ApiError) {
    if (error.status === 403) {
      displayed = 'Only the person who made this plan can change that.';
    } else if (error.status === 404) {
      displayed = "This isn't here any more.";
    } else if (error.status === 429 && error.retryAfterSeconds !== undefined) {
      displayed = `Too many requests. Try again in ${error.retryAfterSeconds} seconds.`;
    } else if (error.status >= 500) {
      displayed = 'Something went wrong.';
    }
  }
  return {
    message: displayed,
    tone: 'error',
    ...(error instanceof ApiError && error.requestId !== undefined
      ? { requestId: error.requestId }
      : {}),
    ...(isRetryable(error) ? { action: { label: 'Retry', onPress: retry } } : {}),
  };
}

/** Re-reads the projection after a write. Resolved per platform by `useListDetail`. */
export type OnWatchItemChanged = () => void;

export function useWatchActions(onChanged: OnWatchItemChanged): WatchActions {
  const show = useToast((state) => state.show);
  const showUndo = useToast((state) => state.showUndo);
  const dismiss = useToast((state) => state.dismiss);

  /** One write, one toast, one inverse — the only difference between the two actions. */
  const write = useCallback(
    (
      listId: string,
      itemId: string,
      title: string,
      forward: PatchListItemInput,
      inverse: PatchListItemInput,
      toast: typeof markedWatchedToast,
    ) => {
      // The accepted action owns the singleton toast slot before this request can settle.
      dismiss();
      const send = (body: PatchListItemInput, offerUndo: boolean, failure: string) => {
        void patchListItem(apiClient, listId, itemId, body)
          .then(() => {
            onChanged();
            if (!offerUndo) return;
            showUndo(
              toast({
                title,
                onUndo: () => {
                  dismiss();
                  // Compensating, and offered no undo of its own: undoing an undo is the
                  // original action, which the user can take again from the row.
                  send(inverse, false, `Couldn't undo that.`);
                },
                onCommit: () => undefined,
              }),
            );
          })
          .catch((error: unknown) => {
            show(failureToast(error, failure, () => send(body, offerUndo, failure)));
          });
      };
      send(forward, true, `Couldn't update "${title}."`);
    },
    [dismiss, onChanged, show, showUndo],
  );

  return {
    markWatched: useCallback(
      (listId, item) => {
        const forward = markWatchedPatch(item);
        const inverse = restoreStatusPatch(item);
        if (forward === undefined || inverse === undefined) return;
        write(listId, item.itemId, item.title, forward, inverse, markedWatchedToast);
      },
      [write],
    ),
    confirmFollowUp: useCallback(
      (followUp) => {
        write(
          followUp.listId,
          followUp.itemId,
          // The list's title is what §8.4's copy names; the toast names the row that changed,
          // and the payload does not carry the item's own title. P3-43 renders the question.
          followUp.listTitle,
          followUpItemPatch(followUp),
          followUpUndoPatch(followUp),
          watchProgressToast,
        );
      },
      [write],
    ),
  };
}
