import { patchMe } from '@od/shared/client';
import { resolveSlot, type SlotResolution } from '@od/shared/lists';
import type { DefaultSlot, List, User } from '@od/shared/types';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useEligibleLists } from '@/hooks/useEligibleLists';
import { ME_QUERY_KEY, useViewer } from '@/hooks/useViewer';
import { apiClient } from '@/lib/apiClient';

/**
 * Where an add-to flow puts things (P3-12's four-step rule on the client, P3-43).
 *
 * One resolver — `resolveSlot` from `@od/shared` — used by every add-to flow, so Meal
 * ingredients and Watch items cannot drift apart (the phase's risk row on hard-coding "the
 * Groceries list"). The answer is always **shown** before a write; this hook only decides
 * what the row says and whether a question is due.
 *
 * - `override` is this operation's one-off choice from the `▾`. It never touches the
 *   stored default (§5.8: changing the destination from the `use` case writes nothing).
 * - `remember` stores the answer to the one-time question in `user.defaultLists`, which is
 *   the only write here and the only way a default is ever set from a flow.
 * - Opening a list never changes anything here: the resolver reads slots and the profile,
 *   never browsing history (ADR-033).
 */
export interface Destination {
  readonly status: 'pending' | 'success' | 'error';
  readonly resolution: SlotResolution<List> | undefined;
  /** The list the write would go to right now — the override, else the resolver's `use`. */
  readonly list: List | undefined;
  /** Every list holding the slot and not archived, in server order — the picker's rows. */
  readonly candidates: readonly List[];
  /** Every list the viewer holds, for `Choose another list`. */
  readonly all: readonly List[];
  /** `true` while the answer is a one-time question the user has not yet answered. */
  readonly needsAnswer: boolean;
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
    const resolution =
      status === 'success' ? resolveSlot(slot, lists, viewer?.defaultLists) : undefined;
    const candidates = lists.filter((list) => list.slot === slot && !list.archived);
    const overridden =
      override === undefined ? undefined : lists.find((l) => l.listId === override);
    const resolved =
      resolution?.kind === 'use'
        ? lists.find((list) => list.listId === resolution.listId)
        : undefined;
    const list = overridden ?? resolved;
    return {
      status,
      resolution,
      list,
      candidates,
      all: lists.filter((list) => !list.archived),
      needsAnswer: overridden === undefined && resolution?.kind === 'ask',
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
