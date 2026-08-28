import { randomUUID } from 'expo-crypto';
import { useState } from 'react';
import { ListTransactionService } from '@/lib/sqlite/listTransactions';
import { requireActiveNativeState } from '@/lib/sqlite/nativeState';
import type { ItemPatchResult } from './useItemPatch';

/**
 * One field of one item, on **native**: accepted into SQLite, then synced (§P3-29, ADR-057).
 *
 * The visible row and the queued `['list','item-patch']` intent commit in **one** transaction,
 * which is `interaction-contract.md` §5.4's writes rule for a migrated domain and the reason
 * this file exists at all: a projected edit with no intent is a change that never syncs, and an
 * intent with no projected edit is a change the user cannot see they made.
 *
 * ## The merge happens inside the writer
 *
 * `patchItem` re-reads the row in its own transaction before applying the fields. Two quick
 * edits to the same box therefore land as the second value rather than as whichever response
 * returned last, and an edit to an item created a moment ago merges onto the create's own
 * committed row instead of onto whatever the screen had rendered.
 *
 * ## Accepted is not acknowledged
 *
 * This resolves when SQLite has the edit, not when the server does. That is the point — the
 * write survives the app being closed and replays under the same intent identity — and it is
 * why a rejection surfaces later through the recovery banner rather than here.
 */
export function useItemPatch(): ItemPatchResult {
  const state = requireActiveNativeState();
  const [saving, setSaving] = useState(false);

  return {
    patch: async (item, changes) => {
      const items = state.listItems;
      const lists = state.lists;
      if (items === undefined || lists === undefined) {
        return { ok: false, error: new Error('Native list item state is not ready.') };
      }
      setSaving(true);
      try {
        const intentId = randomUUID();
        const service = new ListTransactionService(state.outbox, lists, items);
        await state.account.transactions.run(
          (transaction) =>
            service.patchItem(transaction, {
              listId: item.listId,
              itemId: item.itemId,
              intentId,
              idempotencyKey: intentId,
              input: changes,
            }),
          'interactive',
        );
        state.sync.request('accepted-action');
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
