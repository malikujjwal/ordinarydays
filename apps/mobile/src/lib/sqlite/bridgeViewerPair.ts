import type { Activity, ListItemActivityLink } from '@od/shared/types';
import type { ViewerPlanPair } from '@/lib/sqlite/listItemsRepository';

/**
 * The List-row Plan pair is the current pointer and that pointer's own state, or nothing.
 *
 * A replayed create can return today's `viewerLink` (Plan B) beside the Activity this intent
 * just installed (Plan A). Pairing those halves would show A's date/status on a row that
 * opens B. Omit the pair until a later pull hydrates B; never invent a mixed pair.
 */
export function bridgeViewerPair(
  link: ListItemActivityLink,
  plan: Pick<Activity, 'activityId' | 'objectKind' | 'type' | 'status' | 'schedule'>,
): ViewerPlanPair | undefined {
  if (link.activityId !== plan.activityId || plan.objectKind !== 'plan') return undefined;
  return {
    viewerLink: link,
    viewerPlan: {
      type: plan.type,
      status: plan.status,
      ...(plan.schedule === undefined ? {} : { schedule: plan.schedule }),
    },
  };
}
