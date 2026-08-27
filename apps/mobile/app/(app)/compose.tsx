import { getMe } from '@od/shared/client';
import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ComposeScreen } from '@/features/compose/components/ComposeScreen';
import { NewListSheet } from '@/features/lists/components/NewListSheet';
import { useLists } from '@/features/lists/hooks/useLists';
import { apiClient } from '@/lib/apiClient';
import { useComposeDraft } from '@/stores/composeDraft';

const profileQuery = queryOptions({
  queryKey: ['me'],
  queryFn: ({ signal }) => getMe(apiClient, signal),
});

/**
 * The Add flow, presented modally (P1-24, P3-27).
 *
 * Thin by rule (`tech-stack.md` §3.2): it reads no params, owns no data of its own, and
 * renders one feature component. What it supplies is `onClose` plus the edge values — the
 * user's today and their zone — so `ComposeScreen` never has to know it is a route.
 *
 * ## Why the lists arrive here
 *
 * `List item` needs a destination, and the lists belong to another feature slice.
 * `no-cross-feature-imports` makes a **route** the one place allowed to see both, so this file
 * reads the index and hands the compose screen a plain array in the server's own pointer
 * order. Nothing is filtered, sorted or pre-selected on the way through, and no default or
 * recent destination is consulted (criterion 33, ADR-033).
 *
 * `New list` opens P3-26's sheet from here for the same reason, and §5.4 rule 5 is why its
 * `onCreated` calls `chooseList`: creating from the picker returns to the item form with the
 * new list visibly selected and its name on the final button.
 */
export default function ComposeRoute() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const profile = useQuery(profileQuery);
  const lists = useLists();
  const chooseList = useComposeDraft((state) => state.chooseList);
  const [creatingList, setCreatingList] = useState(false);

  return (
    <>
      <ComposeScreen
        onClose={() => router.back()}
        today={format(new Date(), 'yyyy-MM-dd')}
        timezone={Intl.DateTimeFormat().resolvedOptions().timeZone}
        loadEventDefaults={async () => {
          const user = profile.data ?? (await queryClient.ensureQueryData(profileQuery));
          return { reservationName: user.displayName, currency: user.currency };
        }}
        listDestinations={{
          // Archived lists are not destinations: they have left the index, and adding to one
          // would put the item somewhere the user would have to go looking for.
          lists: lists.lists
            .filter((list) => !list.archived)
            .map((list) => ({ listId: list.listId, title: list.title })),
          status: lists.status,
          refetch: lists.refetch,
        }}
        onCreateList={() => setCreatingList(true)}
      />
      <NewListSheet
        open={creatingList}
        onClose={() => setCreatingList(false)}
        onCreated={(listId) => {
          setCreatingList(false);
          chooseList(listId);
        }}
      />
    </>
  );
}
