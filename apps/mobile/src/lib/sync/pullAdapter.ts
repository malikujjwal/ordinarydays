import {
  getActivity,
  getAgenda,
  getList,
  getListItems,
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
import type { ListItemRow } from '@/lib/sqlite/listItemsRepository';

/** Typed reads used by the one native sync owner; returned bodies are never UI fallbacks. */
export interface ActivityPullAdapter {
  agenda(request: AgendaQuery, signal?: AbortSignal): Promise<AgendaData>;
  activity(target: ActivityDetailTarget, signal?: AbortSignal): Promise<ActivityDetail>;
  profile(signal?: AbortSignal): Promise<User>;
  anytimePage?(
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<{
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
  listsPage?(
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<{
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
  list?(listId: string, signal?: AbortSignal): Promise<List>;
  /**
   * One List's META **and** its fenced first item page (P3-27).
   *
   * The two travel together because the page is fenced by the META `rankVersion` that issued
   * its cursor: fetching them separately would let a repair land between the two reads and
   * produce a projection whose rows and cursor belong to different generations — the exact
   * thing the `503` fence exists to make impossible.
   */
  listDetail?(
    listId: string,
    signal?: AbortSignal,
  ): Promise<{
    readonly list: List;
    readonly items: readonly ListItemRow[];
    readonly nextCursor?: string;
  }>;
  /** A subsequent item page, by the cursor page one (or the page before) returned. */
  listItemsPage?(
    listId: string,
    cursor: string,
    signal?: AbortSignal,
  ): Promise<{ readonly items: readonly ListItemRow[]; readonly nextCursor?: string }>;
  /** One item by its exact id, for durable-create collision recovery (§P3-08). */
  listItem?(listId: string, itemId: string, signal?: AbortSignal): Promise<ListItemRow>;
}

/**
 * One list-detail entry as the row the projection stores (P3-35): the item, with the caller's
 * `viewerLink` / `viewerPlan` pair flattened on when the union carries it. Pointer and state
 * arrive together or not at all (`api-contract.md` §3), so a bare entry **is** the caller's
 * current truth — no pair — and flattening preserves exactly that.
 */
export function flattenDetailItem(entry: {
  readonly item: unknown;
  readonly viewerLink?: unknown;
  readonly viewerPlan?: unknown;
}): ListItemRow {
  const item = entry.item as ListItemRow;
  if (entry.viewerLink === undefined || entry.viewerPlan === undefined) return item;
  return {
    ...item,
    viewerLink: entry.viewerLink,
    viewerPlan: entry.viewerPlan,
  } as ListItemRow;
}

export const sharedActivityPullAdapter: ActivityPullAdapter = {
  agenda: (request, signal) => getAgenda(apiClient, request, signal),
  activity: (target, signal) => getActivity(apiClient, target, signal),
  profile: (signal) => getMe(apiClient, signal),
  anytimePage: async (cursor, signal) => {
    const page = await listActivities(
      apiClient,
      {
        filter: 'saved',
        limit: 200,
        ...(cursor === undefined ? {} : { cursor }),
      },
      signal,
    );
    return {
      data: page.data as ActivityListItem[],
      ...(page.meta.nextCursor === undefined ? {} : { nextCursor: page.meta.nextCursor }),
    };
  },
  list: async (listId, signal) => {
    const detail = await getList(apiClient, listId, {}, signal);
    return detail.list as List;
  },
  listDetail: async (listId, signal) => {
    const detail = await getList(apiClient, listId, { includeItems: true }, signal);
    return {
      list: detail.list as List,
      items: (detail.items ?? []).map(flattenDetailItem),
      ...(detail.nextCursor === undefined ? {} : { nextCursor: detail.nextCursor }),
    };
  },
  listItemsPage: async (listId, cursor, signal) => {
    const page = await getListItems(apiClient, listId, cursor, signal);
    return {
      items: page.data.map(flattenDetailItem),
      ...(page.meta.nextCursor === undefined ? {} : { nextCursor: page.meta.nextCursor }),
    };
  },
  listItem: async (listId, itemId, signal) => {
    const { getListItem } = await import('@od/shared/client');
    return (await getListItem(apiClient, listId, itemId, signal)) as ListItemRow;
  },
  listsPage: async (cursor, signal) => {
    const page = await getLists(apiClient, cursor, signal);
    return {
      data: page.data as List[],
      ...(page.meta.nextCursor === undefined ? {} : { nextCursor: page.meta.nextCursor }),
    };
  },
};
