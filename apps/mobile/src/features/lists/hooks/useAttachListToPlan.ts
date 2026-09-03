import { patchList } from '@od/shared/client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { randomUUID } from 'expo-crypto';
import { useState } from 'react';
import { apiClient } from '@/lib/apiClient';
import { describeApiFailure } from '@/lib/apiFailure';
import { listMutationKeys } from '@/lib/mutationKeys';
import { LISTS_KEY } from './keys';
import type { ListIndexEntry } from './useLists';

export interface AttachListToPlanResult {
  readonly attach: (
    list: Pick<ListIndexEntry, 'listId' | 'updatedAt'>,
    sourceActivityId: string,
  ) => Promise<boolean>;
  readonly isAttaching: boolean;
  readonly errorMessage: string | undefined;
  readonly errorRequestId: string | undefined;
  readonly dismissError: () => void;
}

/** Web's online half of the attach-only List settings operation. */
export function useAttachListToPlan(): AttachListToPlanResult {
  const queryClient = useQueryClient();
  const [error, setError] = useState<unknown>();
  const mutation = useMutation({
    mutationKey: listMutationKeys.patch,
    mutationFn: ({
      list,
      input,
    }: {
      list: Pick<ListIndexEntry, 'listId' | 'updatedAt'>;
      input: { sourceActivityId: string };
    }) => patchList(apiClient, list.listId, input, list.updatedAt, randomUUID()),
  });
  const failure =
    error === undefined
      ? undefined
      : describeApiFailure(error, "Couldn't add this list.");

  return {
    attach: async (list, sourceActivityId) => {
      try {
        setError(undefined);
        await mutation.mutateAsync({ list, input: { sourceActivityId } });
        await queryClient.invalidateQueries({ queryKey: LISTS_KEY });
        return true;
      } catch (caught) {
        setError(caught);
        return false;
      }
    },
    isAttaching: mutation.isPending,
    errorMessage: failure?.message,
    errorRequestId: failure?.requestId,
    dismissError: () => {
      setError(undefined);
      mutation.reset();
    },
  };
}
