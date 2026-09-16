import { patchMe } from '@od/shared/client';
import type { DefaultSlot, List, User } from '@od/shared/types';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useEligibleLists } from '@/hooks/useEligibleLists';
import { ME_QUERY_KEY, useViewer } from '@/hooks/useViewer';
import { apiClient } from '@/lib/apiClient';
import { destinationCapableLists } from '@/lib/destinationCapability';

/**
 * Where an add-to flow puts things, flattened (P3-43; supersedes P3-12's four-step rule —
 * `docs/reports/destination-flow-simplification-20260916.md` Option B1).
 *
 * One capability boundary — `destinationCapableLists`, itself the one shared
 * `canReceiveIngredients`/`listCapabilities` rule — filters every list this hook can ever
 * return, so the picker can never offer, and an override or a stored default can never
 * resolve to, a list the API would refuse.
 *
 * - `override` is this operation's one-off choice from the `▾`. It never touches the stored
 *   default: an override always wins for this operation, and changing it writes nothing.
 * - The stored `slot` on `user.defaultLists` **is** the remembered default — unchanged wire
 *   shape, unchanged server-side cleanup on a list's delete or slot change. B1 removes the
 *   one-time question and its checkbox, not the default itself (ADR-033 still holds).
 * - `remember` is the only write here, and the only way a default is ever set: the caller
 *   fires it once, silently, the first time the user picks a list while none is stored.
 * - A single capable list is still used silently and named, exactly as ADR-033's step 1 —
 *   `hasDefault` stays `false` for it, so picking a *different* list still writes a default.
 * - A stored default that no longer names a capable, present list is treated as absent
 *   (deleted, archived, or its state/slot changed since) and never surfaces as an error.
 */
export interface Destination {
  readonly status: 'pending' | 'success' | 'error';
  /** Every capable, non-archived list the viewer holds, in server order — the picker's rows. */
  readonly lists: readonly List[];
  /** The list this write would go to right now: the override, the stored default, or (only
   *  while it is the sole capable list) that list, silently. */
  readonly list: List | undefined;
  /** A default is stored and still names a capable, present list — the caller must not
   *  `remember` silently again until the user deliberately picks a different one. */
  readonly hasDefault: boolean;
  readonly remember: (listId: string) => Promise<void>;
  readonly remembering: boolean;
}

/**
 * `enabled` false keeps the hook quiet — no list or profile request — for a form that has
 * no destination to show yet (a Task, a Watch with the toggle off): the resolution is only
 * needed once there is something to add somewhere.
 */
export function useDestination(
  slot: DefaultSlot,
  override: string | undefined,
  enabled = true,
): Destination {
  const queryClient = useQueryClient();
  const viewer = useViewer(enabled);
  const { lists, status } = useEligibleLists(enabled);

  const remember = useMutation({
    mutationFn: (listId: string) =>
      patchMe(apiClient, { defaultLists: { [slot]: listId } }),
    onSuccess: (user: User) => queryClient.setQueryData(ME_QUERY_KEY, user),
  });

  return useMemo(() => {
    const capableLists = destinationCapableLists(slot, lists);
    const overridden =
      override === undefined
        ? undefined
        : capableLists.find((candidate) => candidate.listId === override);
    const storedDefaultId = viewer?.defaultLists?.[slot];
    const defaulted =
      storedDefaultId === undefined
        ? undefined
        : capableLists.find((candidate) => candidate.listId === storedDefaultId);
    const onlyCapable = capableLists.length === 1 ? capableLists[0] : undefined;
    const list = overridden ?? defaulted ?? onlyCapable;
    return {
      status,
      lists: capableLists,
      list,
      hasDefault: defaulted !== undefined,
      remember: async (listId) => {
        await remember.mutateAsync(listId);
      },
      remembering: remember.isPending,
    };
  }, [
    lists,
    override,
    remember.isPending,
    remember.mutateAsync,
    slot,
    status,
    viewer?.defaultLists,
  ]);
}
