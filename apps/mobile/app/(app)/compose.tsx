import { getMe } from '@od/shared/client';
import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ComposeScreen } from '@/features/compose/components/ComposeScreen';
import type { ListDestination } from '@/features/compose/components/ListDestinationChooser';
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
 * The route is the allowed cross-feature seam: it supplies List destinations without compose
 * sorting, inferring, or remembering one. New List returns here with the draft intact.
 */
export default function ComposeRoute() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const profile = useQuery(profileQuery);
  const lists = useLists();
  const chooseList = useComposeDraft((state) => state.chooseList);
  const [creatingList, setCreatingList] = useState(false);
  const [createdDestination, setCreatedDestination] = useState<ListDestination>();
  const availableDestinations = lists.lists
    .filter((list) => !list.archived)
    .map((list) => ({ listId: list.listId, title: list.title }));
  const listDestinations =
    createdDestination === undefined ||
    availableDestinations.some((list) => list.listId === createdDestination.listId)
      ? availableDestinations
      : [...availableDestinations, createdDestination];

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
          lists: listDestinations,
          status: lists.status,
          refetch: lists.refetch,
        }}
        onCreateList={() => setCreatingList(true)}
      />
      <NewListSheet
        open={creatingList}
        onClose={() => setCreatingList(false)}
        onCreated={(created) => {
          setCreatingList(false);
          setCreatedDestination(created);
          chooseList(created.listId);
        }}
      />
    </>
  );
}
