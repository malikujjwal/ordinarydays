import { getMe } from '@od/shared/client';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { useRouter } from 'expo-router';
import { ComposeScreen } from '@/features/compose/components/ComposeScreen';
import { apiClient } from '@/lib/apiClient';

/**
 * The Add flow, presented modally (P1-24).
 *
 * Thin by rule (`tech-stack.md` §3.2): it reads no params, owns no data, and renders one
 * feature component. What it supplies is `onClose` plus the two edge values — the user's
 * today and their zone — so `ComposeScreen` never has to know it is a route, which is what
 * lets Phase 9's share-sheet entry point mount the same component from somewhere that is not
 * a route at all.
 *
 * `today` and `timezone` are read **here** because `coding-standards.md` §4.3 bans
 * implicit-now calls anywhere that has to be testable, and the route is the edge. The same
 * two lines are in `activity/[id].tsx` (P1-26); both become one `useClock()` call when
 * `packages/shared/src/time/` lands.
 *
 * `router.back()` rather than a push to a tab: the modal must return to whichever tab opened
 * it, and pushing would rewrite the user's position in the stack.
 */
export default function ComposeRoute() {
  const router = useRouter();
  const profile = useQuery({
    queryKey: ['me'],
    queryFn: ({ signal }) => getMe(apiClient, signal),
  });

  return (
    <ComposeScreen
      onClose={() => router.back()}
      today={format(new Date(), 'yyyy-MM-dd')}
      timezone={Intl.DateTimeFormat().resolvedOptions().timeZone}
      displayName={profile.data?.displayName ?? ''}
    />
  );
}
