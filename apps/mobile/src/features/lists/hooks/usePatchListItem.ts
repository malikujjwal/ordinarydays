import { type PatchListItemInput, patchListItem } from '@od/shared/client';
import { useState } from 'react';
import { apiClient } from '@/lib/apiClient';
import type { ListItemRow } from '@/lib/sqlite/listItemsRepository';

/**
 * One field of one item, on **web**: one online `PATCH /v1/lists/:id/items/:itemId` (§P3-29).
 *
 * The native file beside this one accepts the same edit into SQLite first. Metro resolves
 * `.native.ts` first, so the sheet imports one name — the `useListDetail` pattern.
 *
 * ## No `Idempotency-Key`, and that is the contract rather than an omission
 *
 * `patchListItem` is not replay-protected: item writes are per-field last-write-wins with no
 * `If-Match` (§5.11.5), so a repeated PATCH carrying the same value *is* the same outcome. The
 * key exists on the create beside it because a repeated create is a second row.
 *
 * ## Failures are returned, not thrown or toasted
 *
 * The caller composes the toast, because it is the caller that knows which field reverts and
 * what the retry re-sends (`interaction-contract.md` §5.3's mutation row). A hook that showed
 * its own toast would leave the sheet holding a value the server rejected.
 */
export interface ItemWriteOutcome {
  readonly ok: boolean;
  /** The rejection, for the caller to describe. Absent on success. */
  readonly error?: unknown;
}

export interface PatchListItemResult {
  /** Sends one field. Resolves once the write is accepted — by the server, or by SQLite. */
  readonly patch: (
    item: ListItemRow,
    changes: PatchListItemInput,
  ) => Promise<ItemWriteOutcome>;
  readonly isSaving: boolean;
}

export function usePatchListItem(): PatchListItemResult {
  const [saving, setSaving] = useState(false);

  return {
    patch: async (item, changes) => {
      setSaving(true);
      try {
        await patchListItem(apiClient, item.listId, item.itemId, changes);
        return { ok: true };
      } catch (error) {
        return { ok: false, error };
      } finally {
        setSaving(false);
      }
    },
    isSaving: saving,
  };
}
