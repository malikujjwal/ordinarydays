import { getMe } from '@od/shared/client';
import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ComposeScreen } from '@/features/compose/components/ComposeScreen';
import { NewListSheet } from '@/features/lists/components/NewListSheet';
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
 * The route is the allowed cross-feature seam: `Add list` opens the ordinary unselected List
 * catalogue without teaching the Activity composer about List creation internals.
 */
export default function ComposeRoute() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const profile = useQuery(profileQuery);
  const resetDraft = useComposeDraft((state) => state.reset);
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
        onCreateList={() => setCreatingList(true)}
      />
      <NewListSheet
        open={creatingList}
        onClose={() => setCreatingList(false)}
        onCreated={() => {
          setCreatingList(false);
          resetDraft();
          router.back();
        }}
      />
    </>
  );
}
