import { format } from 'date-fns';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ActivityDetailScreen } from '@/features/activity/components/ActivityDetailScreen';

/**
 * `/activity/:id` (P1-26).
 *
 * Thin by rule (`tech-stack.md` §3.2): read the param, resolve today, render one feature
 * component. `today` is resolved **here** rather than inside the screen because
 * `coding-standards.md` §4.3 bans implicit-now calls in pure logic and in anything that has
 * to be testable — the route is the edge, so this is where the real clock is allowed to be
 * read. When `packages/shared/src/time/` and its `useClock()` provider land, this line is
 * the only one that changes.
 */
export default function ActivityDetailRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();

  return (
    <ActivityDetailScreen
      activityId={id ?? ''}
      today={format(new Date(), 'yyyy-MM-dd')}
      onBack={() => router.back()}
    />
  );
}
