import { getActivity, getAgenda, getMe } from '@od/shared/client';
import type { AgendaQuery } from '@od/shared/schemas';
import type {
  ActivityDetail,
  ActivityDetailTarget,
  AgendaData,
  User,
} from '@od/shared/types';
import { apiClient } from '@/lib/apiClient';

/** Typed reads used by the one native sync owner; returned bodies are never UI fallbacks. */
export interface ActivityPullAdapter {
  agenda(request: AgendaQuery): Promise<AgendaData>;
  activity(target: ActivityDetailTarget): Promise<ActivityDetail>;
  profile(): Promise<User>;
}

export const sharedActivityPullAdapter: ActivityPullAdapter = {
  agenda: (request) => getAgenda(apiClient, request),
  activity: (target) => getActivity(apiClient, target),
  profile: () => getMe(apiClient),
};
