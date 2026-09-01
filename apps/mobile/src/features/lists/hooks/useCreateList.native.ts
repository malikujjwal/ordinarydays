import { listTemplateSeed } from '@od/shared/lists';
import { randomUUID } from 'expo-crypto';
import { useState } from 'react';
import { nextCanonicalId } from '@/lib/canonicalIds';
import { ListTransactionService } from '@/lib/sqlite/listTransactions';
import { requireActiveNativeState } from '@/lib/sqlite/nativeState';
import type { CreateListResult } from './useCreateList';

/**
 * `Create list` on **native**: accepted into SQLite, then synced (§P3-26, §P3-05, ADR-057).
 *
 * The confirmation mints **one** monotonic `lst_` and **one** mutation id, then commits the
 * visible row and the queued `['list','create']` intent in a single transaction. Both ids are
 * reused by every transport retry, which is the whole of the durability contract: a fresh id
 * on a retry is how one create the user confirmed once becomes two lists.
 *
 * ## Why the seed is resolved here
 *
 * The row has to render offline, before any server response exists, so the fields a create
 * copies are read from the chosen catalogue record — the client doing at confirmation exactly
 * what `listCreationService` does on the server (ADR-032). The key comes from the style the
 * user just **tapped**; nothing here resolves a stored list's `templateKey`, which is the
 * lookup ADR-032 forbids and `check-forbidden.mjs` pins to this file.
 *
 * The seed is then stored on the intent, so a replay after an app update copies what was
 * frozen at confirmation rather than whatever the shipped catalogue says days later.
 */
export function useCreateList(): CreateListResult {
  const state = requireActiveNativeState();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();

  return {
    create: async (templateKey, title, options) => {
      const lists = state.lists;
      if (lists === undefined) {
        setError('Native Lists state is not ready.');
        return undefined;
      }
      const seed = listTemplateSeed(templateKey);
      if (seed === undefined) {
        // No fallback to `simple-list`, on the client for the reason the server has none: a
        // style the app does not know is a client running ahead of its own catalogue, and
        // guessing produces a list that is not what the person tapped.
        setError("That list style isn't available.");
        return undefined;
      }
      setCreating(true);
      try {
        const listId = nextCanonicalId('lst');
        const intentId = randomUUID();
        await state.account.transactions.run(
          (transaction) =>
            new ListTransactionService(state.outbox, lists).create(
              transaction,
              state.ownerUserId,
              {
                listId,
                intentId,
                idempotencyKey: intentId,
                // A source Plan rides the durable input; `pendingListFromInput` reads it to
                // force the optimistic row's slot to `null` exactly as the server will.
                input: {
                  listId,
                  title,
                  templateKey,
                  ...(options?.sourceActivityId === undefined
                    ? {}
                    : { sourceActivityId: options.sourceActivityId }),
                },
                seed,
              },
            ),
          'interactive',
        );
        state.sync.request('accepted-action');
        setError(undefined);
        return listId;
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Couldn't save this.");
        return undefined;
      } finally {
        setCreating(false);
      }
    },
    isCreating: creating,
    errorMessage: error,
    errorRequestId: undefined,
    dismissError: () => setError(undefined),
  };
}
