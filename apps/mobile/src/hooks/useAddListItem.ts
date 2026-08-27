import { ApiError, createListItem } from '@od/shared/client';
import { randomUUID } from 'expo-crypto';
import { useState } from 'react';
import { apiClient } from '@/lib/apiClient';

/**
 * `Add to {list name}` on **web**: one online `POST /v1/lists/:id/items` (P3-27).
 *
 * In `src/hooks/` rather than in the lists slice because **two features commit this write** —
 * list detail's inline add row and the global `List item` route in compose — and
 * `repo-structure.md` §3.2 moves a thing two features need up rather than letting one import
 * the other's. `no-cross-feature-imports` enforces that rather than suggesting it.
 *
 * The native file beside this one accepts the same confirmation into SQLite first. Web mints
 * the **key**, native mints the **id** — the split `useCreateList` records, for ADR-024's
 * reason: a browser tab is closed rather than backgrounded, so there is no queue to name a row
 * ahead of.
 *
 * ## One write per commit, and the list is a parameter
 *
 * `listId` arrives from the caller — the list whose detail this is, or the one the user picked
 * — and is the path id. Nothing here reads a default, a recent destination or a title
 * (criterion 33). There is no argument through which one could.
 */
/** Title and note — §5.7's fields for every behaviour. The rest is the item sheet's (P3-29). */
export interface AddListItemFields {
  readonly title: string;
  readonly note?: string;
}

export interface AddListItemResult {
  /** Writes one item and answers with its id, so a caller can scroll or re-focus. */
  add: (listId: string, fields: AddListItemFields) => Promise<string | undefined>;
  isAdding: boolean;
  errorMessage: string | undefined;
  dismissError: () => void;
}

export function describeAddFailure(error: unknown): string {
  if (error instanceof ApiError) {
    return error.status >= 500 ? 'Something went wrong.' : error.message;
  }
  return "Couldn't save this.";
}

export function useAddListItem(): AddListItemResult {
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string>();

  return {
    add: async (listId, fields) => {
      setAdding(true);
      try {
        // `expo-crypto`, not `crypto.randomUUID`: absent from some Hermes builds, and an
        // idempotency key is the wrong place to find that out.
        const item = await createListItem(
          apiClient,
          listId,
          {
            title: fields.title,
            ...(fields.note === undefined ? {} : { note: fields.note }),
          },
          randomUUID(),
        );
        setError(undefined);
        return item.itemId;
      } catch (caught) {
        setError(describeAddFailure(caught));
        return undefined;
      } finally {
        setAdding(false);
      }
    },
    isAdding: adding,
    errorMessage: error,
    dismissError: () => setError(undefined),
  };
}
