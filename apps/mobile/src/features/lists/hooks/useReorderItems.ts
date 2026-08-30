import { ApiError, isRetryable, patchListItem } from '@od/shared/client';
import { onlineManager } from '@tanstack/react-query';
import { randomUUID } from 'expo-crypto';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiClient } from '@/lib/apiClient';
import type { ListItemRow } from '@/lib/sqlite/listItemsRepository';
import { type ToastMessage, useToast } from '@/stores/toast';
import {
  orderedItems,
  planReorder,
  REORDER_OFFLINE_MESSAGE,
  type ReorderList,
} from '../model/reorder';

/**
 * The write behind one drag (§P3-30, `plans-and-lists.md` §5.6).
 *
 * One hook for both platforms: only the projection write differs, and `applyRank` already
 * resolves that per platform — SQLite on native, this hook's own state on web. Everything here
 * — the connectivity gate, the single request, the revert — is the same decision on either.
 *
 * ## Connectivity is consulted **at drop**, not at drag start
 *
 * §P3-30 makes reorder online-only, and the moment that matters is the one where a write would
 * otherwise be enqueued. A drag begun on a train and dropped in a station should go; a drag
 * begun in a station and dropped in a tunnel must not. So the gate is here, on the drop, and
 * when it refuses **nothing at all happens**: the row springs back, `Reordering needs a
 * connection.` appears verbatim, and no outbox intent, no `Pending` row and no request exist to
 * be reconciled later. That absence is the point — a queued reorder would replay against
 * neighbours the list no longer has.
 *
 * ## One request, and it carries a position
 *
 * `afterItemId` and nothing else — `null` for the head, because absent means *no reorder* on
 * this route. The client never sends a rank: the server allocates it under its own
 * `rankVersion` (P3-03/P3-08), and a client that sent one would be allocating in a keyspace it
 * cannot see. The optimistic row's provisional rank stays on the device.
 *
 * ## The key is stable for the whole drag, including its Retry
 *
 * One drag is one logical mutation. `Retry` re-sends **the same plan** — the same
 * `afterItemId`, computed once from the order the finger actually saw — rather than
 * recomputing a position against a list that has moved on since. The key is what makes that
 * safe: a `Retry` tapped after the user has already dragged something else is refused, because
 * the row it names is no longer the one that drag was about.
 *
 * > **Raised in this PR.** §P3-30 says "an online request still carries its stable
 * > `Idempotency-Key`", but `api-contract.md` §2.7 and `routes/lists.ts` both say only the
 * > mutating `POST`s take that header, and `patchListItem` deliberately sends none because the
 * > route is not replay-protected. The architecture doc wins on mechanics (playbook §2), and
 * > the reorder is idempotent by construction anyway — `afterItemId` is an absolute position,
 * > so re-sending it produces the same order. The key is therefore held here, where it makes
 * > `Retry` one mutation rather than two, and does not travel.
 */
export interface ReorderItems {
  /** The projection with at most one in-flight drag overlaid by stable item id. */
  readonly items: readonly ListItemRow[];
  /**
   * Drops `itemId` at an insertion index in the list **with that row removed**.
   *
   * A no-op drop, an unknown row and a cross-group target on a `watch` list all return without
   * a request — {@link planReorder} decides which, and this hook does not second-guess it.
   */
  readonly drop: (itemId: string, toIndex: number) => void;
}

interface OptimisticMove {
  readonly dragId: string;
  readonly itemId: string;
  readonly rank: string;
  readonly acknowledged: boolean;
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

export interface ReorderContext {
  readonly listId: string;
  readonly list: ReorderList;
  readonly items: readonly ListItemRow[];
  /** The projection's own write. Resolved per platform by `useListDetail`. */
  readonly applyRank: (itemId: string, rank: string) => void;
  /** Re-reads the projection once the server's rank has been installed. */
  readonly onMoved: () => void;
}

export function useReorderItems({
  listId,
  list,
  items,
  applyRank,
  onMoved,
}: ReorderContext): ReorderItems {
  const show = useToast((state) => state.show);
  /** The drag whose request may still write. A newer drop retires the previous one. */
  const activeDrag = useRef<string | undefined>(undefined);
  const [optimistic, setOptimistic] = useState<OptimisticMove>();
  const displayItems = useMemo(
    () =>
      orderedItems(
        items.map((item) =>
          item.itemId === optimistic?.itemId ? { ...item, rank: optimistic.rank } : item,
        ),
      ),
    [items, optimistic],
  );

  /*
   * Keep the overlay through the request and the platform projection write. Web installs the
   * rank in React state; native commits it through SQLite. Clearing before either one appears
   * would replay the old order between drop and reconciliation.
   */
  useEffect(() => {
    if (!optimistic?.acknowledged) return;
    const reconciled = items.some(
      (item) => item.itemId === optimistic.itemId && item.rank === optimistic.rank,
    );
    if (!reconciled) return;
    setOptimistic((current) =>
      current?.dragId === optimistic.dragId ? undefined : current,
    );
  }, [items, optimistic]);

  const drop = useCallback(
    (itemId: string, toIndex: number) => {
      const sorted = displayItems;
      const plan = planReorder(list, sorted, itemId, toIndex);
      // A drop back where it started, or one the watch guard refused. No write, no toast.
      if (plan === undefined) return;

      /*
       * The gate, and the whole of the online-only rule: the row is already back where it was,
       * because nothing has moved it yet.
       */
      if (!onlineManager.isOnline()) {
        show({ message: REORDER_OFFLINE_MESSAGE, tone: 'error' });
        return;
      }

      if (!sorted.some((candidate) => candidate.itemId === itemId)) return;
      // One drag, one identity, reused by its own `Retry` so two attempts are one mutation.
      const dragId = randomUUID();
      activeDrag.current = dragId;

      const send = () => {
        // A newer drag has taken the row since. That drag's position is the live one.
        if (activeDrag.current !== dragId) return;
        if (plan.rank !== undefined) {
          setOptimistic({
            dragId,
            itemId,
            rank: plan.rank,
            acknowledged: false,
          });
        }
        void patchListItem(apiClient, listId, itemId, {
          /*
           * The position, and only the position. A rank here would be the client allocating in
           * a keyspace it cannot see — and an *absent* `afterItemId` would be no reorder at
           * all, which is why the head sends `null` rather than nothing.
           */
          afterItemId: plan.afterItemId,
        })
          .then((moved) => {
            if (activeDrag.current !== dragId) return;
            setOptimistic({
              dragId,
              itemId,
              rank: moved.rank,
              acknowledged: true,
            });
            applyRank(itemId, moved.rank);
            onMoved();
            activeDrag.current = undefined;
          })
          .catch((error: unknown) => {
            if (activeDrag.current !== dragId) return;
            setOptimistic((current) =>
              current?.dragId === dragId ? undefined : current,
            );
            show(failureToast(error, "Couldn't move that.", send));
          });
      };

      send();
    },
    [applyRank, displayItems, list, listId, onMoved, show],
  );

  return { items: displayItems, drop };
}
