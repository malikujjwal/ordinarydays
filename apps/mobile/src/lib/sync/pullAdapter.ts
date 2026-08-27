import {
  getActivity,
  getAgenda,
  getList,
  getLists,
  getMe,
  listActivities,
} from '@od/shared/client';
import type { AgendaQuery } from '@od/shared/schemas';
import type {
  ActivityDetail,
  ActivityDetailTarget,
  ActivityListItem,
  AgendaData,
  List,
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
  /**
   * One page of List access pointers with their `META` rows (P3-25).
   *
   * The endpoint does **not** filter by `archived` — active and archived pointers arrive
   * together and the index filters client-side — so this returns the page verbatim and the
   * caller drains every cursor before deciding anything.
   */
  listsPage?(cursor?: string): Promise<{
    readonly data: readonly List[];
    readonly nextCursor?: string;
  }>;
  /**
   * One List by its exact id, for durable-create collision recovery (§P3-05).
   *
   * The **exact** read is what makes the recovery decidable: `200` means this device's minted
   * id already names a list it owns, so the create landed and the canonical row is adopted;
   * `404` means the id collided with something the caller cannot see, which no amount of
   * retrying resolves. A page read could not tell those apart.
   *
   * Items are deliberately not requested. Recovery is about identity, and a create has none.
   */
  list?(listId: string): Promise<List>;
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
  list: async (listId) => {
    const detail = await getList(apiClient, listId);
    return detail.list as List;
  },
  listsPage: async (cursor) => {
    const page = await getLists(apiClient, cursor);
    return {
      data: page.data as List[],
      ...(page.meta.nextCursor === undefined ? {} : { nextCursor: page.meta.nextCursor }),
    };
  },
};
