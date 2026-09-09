import { getMe } from '@od/shared/client';
import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ComposeScreen } from '@/features/compose/components/ComposeScreen';
import { DestinationSheet } from '@/features/lists/components/DestinationSheet';
import { useCreateList } from '@/features/lists/hooks/useCreateList';
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
 * The route is the allowed cross-feature seam: List creation is written through
 * `useCreateList` without teaching the Activity composer about List internals.
 */
export default function ComposeRoute() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const profile = useQuery(profileQuery);
  const createList = useCreateList();
  // P3-43: the destination picker meets the compose feature here (features stay vertical).
  const [choosingSlot, setChoosingSlot] = useState<'groceries' | 'watch'>();
  const destinations = useComposeDraft((state) => state.destinations);
  const setDestination = useComposeDraft((state) => state.setDestination);

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
        listWriter={{
          save: (templateKey, title) => createList.create(templateKey, title),
          isCreating: createList.isCreating,
          errorMessage: createList.errorMessage,
          errorRequestId: createList.errorRequestId,
        }}
        onChooseDestination={setChoosingSlot}
      />
      {choosingSlot === undefined ? null : (
        <DestinationSheet
          open
          slot={choosingSlot}
          current={destinations[choosingSlot]}
          onChoose={(listId) => setDestination(choosingSlot, listId)}
          onClose={() => setChoosingSlot(undefined)}
        />
      )}
    </>
  );
}
