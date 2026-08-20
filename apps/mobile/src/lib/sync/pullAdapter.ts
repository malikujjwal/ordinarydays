import { getActivity, getAgenda, getMe, listActivities } from '@od/shared/client';
import type { AgendaQuery } from '@od/shared/schemas';
import type {
  ActivityDetail,
  ActivityDetailTarget,
  ActivityListItem,
  AgendaData,
  User,
} from '@od/shared/types';
import { apiClient } from '@/lib/apiClient';

/** Typed reads used by the one native sync owner; returned bodies are never UI fallbacks. */
export interface ActivityPullAdapter {
  agenda(request: AgendaQuery): Promise<AgendaData>;
  activity(target: ActivityDetailTarget): Promise<ActivityDetail>;
  profile(): Promise<User>;
  anytimePage?(cursor?: string): Promise<{
    readonly data: readonly ActivityListItem[];
    readonly nextCursor?: string;
  }>;
}

export const sharedActivityPullAdapter: ActivityPullAdapter = {
  agenda: (request) => getAgenda(apiClient, request),
  activity: (target) => getActivity(apiClient, target),
  profile: () => getMe(apiClient),
  anytimePage: async (cursor) => {
    const page = await listActivities(apiClient, {
      filter: 'saved',
      limit: 200,
      ...(cursor === undefined ? {} : { cursor }),
    });
    return {
      data: page.data as ActivityListItem[],
      ...(page.meta.nextCursor === undefined ? {} : { nextCursor: page.meta.nextCursor }),
    };
  },
};
