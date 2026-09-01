import type { ActivityDetailTarget } from '@od/shared/types';
import { format } from 'date-fns';
import { type Href, useLocalSearchParams, useRouter } from 'expo-router';
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
  const { id, resolvePassed, occurrenceDate } = useLocalSearchParams<{
    id: string;
    resolvePassed?: string;
    occurrenceDate?: string;
  }>();
  const router = useRouter();
  const activityId = id ?? '';
  const target: ActivityDetailTarget =
    occurrenceDate === undefined
      ? { kind: 'activity', activityId }
      : { kind: 'occurrence', activityId, date: occurrenceDate };

  return (
    <ActivityDetailScreen
      target={target}
      today={format(new Date(), 'yyyy-MM-dd')}
      onBack={() => router.back()}
      {...(resolvePassed === '1'
        ? {
            resolutionOccurrenceDate: occurrenceDate ?? null,
            onResolutionProjectionChange: (resolved: boolean) =>
              router.setParams({ resolvePassed: resolved ? '0' : '1' }),
          }
        : {})}
      /**
       * `replace`, not `push`: the copy takes the original's place in the stack, so Back from
       * it returns where the user came from rather than to the row they just duplicated. Two
       * detail screens for two versions of one thing is a stack nobody asked for.
       */
      onOpenActivity={(next) => router.replace(`/activity/${next}` as Href)}
      // The LISTS and PREP rows (P3-37): a plan's own List or child is somewhere the user
      // goes and comes **back** from, so `push`, unlike the duplicate's replace above.
      onOpenList={(listId) => router.push(`/lists/${listId}` as Href)}
      onOpenChild={(childId) => router.push(`/activity/${childId}` as Href)}
    />
  );
}
