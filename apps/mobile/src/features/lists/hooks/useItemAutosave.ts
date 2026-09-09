import type { PatchListItemInput } from '@od/shared/client';
import { interactionTiming } from '@od/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type ListItemRow, mergeListItemPatch } from '@/lib/sqlite/listItemsRepository';
import { reserveItemWrite } from './itemWriteTurn';

export type ItemField = 'title' | 'note' | 'state' | 'progress' | 'place' | 'subItems';
type Patch = (acknowledged: ListItemRow) => PatchListItemInput | undefined;
export type ItemSaveStatus =
  | 'idle'
  | 'waiting'
  | 'saving'
  | 'saved'
  | 'failed'
  | 'invalid';
type Edit = { patch: Patch; ready: boolean; turn: ReturnType<typeof reserveItemWrite> };
interface FieldQueue {
  status: ItemSaveStatus;
  pending?: Edit;
  running: boolean;
  invalid: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

/** Serial per field, concurrent across independent fields. Native still owns durable writes. */
export function useItemAutosave(
  item: ListItemRow,
  save: (item: ListItemRow, changes: PatchListItemInput) => Promise<boolean>,
) {
  const [statuses, setStatuses] = useState<Partial<Record<ItemField, ItemSaveStatus>>>(
    {},
  );
  const mounted = useRef(true);
  const latest = useRef(item);
  latest.current = item;
  const writer = useRef(save);
  writer.current = save;
  const queues = useRef(new Map<ItemField, FieldQueue>());
  // A refresh can lag an accepted write. Keep that field's acknowledgement until its
  // projection catches up, so returning to an old value still produces the required write.
  const accepted = useRef(new Map<ItemField, PatchListItemInput>());
  const baseline = () => {
    let value = latest.current;
    for (const patch of accepted.current.values())
      value = mergeListItemPatch(value, patch);
    return value;
  };
  const publish = (key: ItemField, queue: FieldQueue) => {
    if (mounted.current) setStatuses((current) => ({ ...current, [key]: queue.status }));
  };
  const get = (key: ItemField) => {
    let queue = queues.current.get(key);
    if (queue === undefined) {
      queue = { status: 'idle', running: false, invalid: false };
      queues.current.set(key, queue);
    }
    return queue;
  };
  const run = async (key: ItemField, queue: FieldQueue): Promise<void> => {
    const edit = queue.pending;
    if (queue.running || edit === undefined || !edit.ready) return;
    delete queue.pending;
    queue.running = true;
    queue.status = 'saving';
    publish(key, queue);
    const outcome = await edit.turn.execute(async () => {
      const current = baseline();
      const patch = edit.patch(current);
      // Deduplicate only this editor's acknowledged value, never a potentially stale row
      // from a newly reopened editor. Callers provide the complete requested field patch.
      if (
        patch === undefined ||
        JSON.stringify(patch) === JSON.stringify(accepted.current.get(key))
      )
        return { ok: true };
      try {
        return { ok: await writer.current(current, patch), patch };
      } catch {
        return { ok: false, patch };
      }
    });
    queue.running = false;
    if (outcome.kind === 'superseded') {
      queue.status = queue.invalid
        ? 'invalid'
        : queue.pending === undefined
          ? 'idle'
          : 'waiting';
      publish(key, queue);
      void run(key, queue);
      return;
    }
    const { ok, patch } = outcome;
    if (!ok) accepted.current.delete(key);
    if (ok && patch !== undefined) accepted.current.set(key, patch);
    if (!ok && queue.invalid) {
      edit.turn.cancel();
      queue.status = 'invalid';
    } else if (!ok) {
      // Keep the newest edit, not the failed request's older snapshot. Retry is explicit.
      if (queue.pending !== undefined) edit.turn.cancel();
      queue.pending ??= edit;
      if (queue.timer !== undefined) clearTimeout(queue.timer);
      delete queue.timer;
      queue.status = 'failed';
    } else if (!queue.invalid) {
      queue.status = queue.pending === undefined ? 'saved' : 'waiting';
    }
    publish(key, queue);
    if (ok) void run(key, queue);
  };
  const field = (key: ItemField) => {
    const queue = get(key);
    const flush = () => {
      if (queue.timer !== undefined) clearTimeout(queue.timer);
      delete queue.timer;
      if (queue.pending !== undefined) queue.pending.ready = true;
      if (queue.status !== 'failed') void run(key, queue);
    };
    const schedule = (patch: Patch) => {
      if (queue.timer !== undefined) clearTimeout(queue.timer);
      queue.invalid = false;
      queue.pending?.turn.cancel();
      queue.pending = {
        patch,
        ready: false,
        turn: reserveItemWrite(`${item.listId}/${item.itemId}/${key}`),
      };
      queue.status = 'waiting';
      publish(key, queue);
      queue.timer = setTimeout(flush, interactionTiming.fieldAutosave);
    };
    return {
      schedule,
      flush,
      now: (patch: Patch) => {
        schedule(patch);
        flush();
      },
      invalid: () => {
        if (queue.timer !== undefined) clearTimeout(queue.timer);
        delete queue.timer;
        queue.pending?.turn.cancel();
        delete queue.pending;
        // Invalidate reservations held by an older dismissed editor too.
        reserveItemWrite(`${item.listId}/${item.itemId}/${key}`).cancel();
        queue.invalid = true;
        queue.status = 'invalid';
        publish(key, queue);
      },
    };
  };
  useEffect(() => {
    // Only release acknowledged overlays when that same field reaches the projection.
    for (const [key, patch] of accepted.current) {
      if (JSON.stringify(mergeListItemPatch(item, patch)) === JSON.stringify(item)) {
        accepted.current.delete(key);
      }
    }
  }, [item]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Close already flushes. Other owner unmounts must not leave debounce callbacks alive.
      for (const queue of queues.current.values()) {
        if (queue.timer !== undefined) clearTimeout(queue.timer);
        if (queue.pending !== undefined && !queue.pending.ready) {
          queue.pending.turn.cancel();
          delete queue.pending;
        }
      }
    };
  }, []);
  const states = Object.values(statuses);
  const status: ItemSaveStatus = states.includes('failed')
    ? 'failed'
    : states.includes('invalid')
      ? 'invalid'
      : [...queues.current.values()].some((queue) => queue.running)
        ? 'saving'
        : states.includes('waiting')
          ? 'waiting'
          : states.includes('saved')
            ? 'saved'
            : 'idle';
  const owns = useCallback((key: ItemField) => {
    const queue = queues.current.get(key);
    return (
      accepted.current.has(key) ||
      (queue !== undefined &&
        (queue.running || queue.pending !== undefined || queue.status === 'invalid'))
    );
  }, []);
  return {
    field,
    status,
    owns,
    releaseFailed: () => {
      for (const queue of queues.current.values()) {
        if (queue.status !== 'failed') continue;
        queue.pending?.turn.cancel();
        delete queue.pending;
      }
    },
    retry: () => {
      for (const [key, queue] of queues.current) {
        if (queue.status !== 'failed' || queue.pending === undefined) continue;
        queue.pending.ready = true;
        void run(key, queue);
      }
    },
  };
}
