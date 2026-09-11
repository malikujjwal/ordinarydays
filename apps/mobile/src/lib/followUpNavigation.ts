import type { Href, ImperativeRouter } from 'expo-router';
import type { FollowUpNavigation } from '@/hooks/useFollowUp';

/** The one router-backed answer to "where do a follow-up's navigation rows go" (P3-44). */
export function followUpNavigation(
  router: Pick<ImperativeRouter, 'push'>,
): FollowUpNavigation {
  return {
    openActivity: (activityId) => router.push(`/activity/${activityId}` as Href),
    openCompose: () => router.push('/compose' as Href),
  };
}
