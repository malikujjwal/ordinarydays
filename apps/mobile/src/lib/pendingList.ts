import type { ListTemplateSeed } from '@od/shared/lists';
import type { CreateListInput } from '@od/shared/schemas';
import type { Instant } from '@od/shared/time';
import type { List } from '@od/shared/types';

/**
 * The List row a native create stores before the server has seen it (§P3-26, ADR-055).
 *
 * The `pendingActivityFromInput` shape, for the other entity a client may name: the durable
 * create is accepted into SQLite first, so the row the user looks at while offline is composed
 * here from what they chose rather than from a response that has not arrived.
 *
 * ## Every seeded value is copied, and copied once
 *
 * `seed` is the five fields `POST /v1/lists` will copy off the same catalogue record (ADR-032).
 * It is passed in rather than resolved here, and stored on the durable intent, so a **replay**
 * after an app update copies the values that were frozen at confirmation instead of whatever
 * the shipped catalogue says days later. That is ADR-032's freezing rule applied to the queue.
 *
 * ## What is a placeholder, and what the ack replaces
 *
 * The counters are what an empty list has. `updatedAt` and `lastItemActivityAt` are the local
 * mint time: they are server-derived, and the row is replaced wholesale by the canonical List
 * on acknowledgement — until then `updatedAt` is not an `If-Match` anybody may use, which is
 * why the coordinator refuses dependent writes on a list whose create has not settled.
 */
export function pendingListFromInput(
  input: CreateListInput,
  seed: ListTemplateSeed,
  listId: string,
  ownerId: string,
  mintedAt: Instant,
): List {
  return {
    listId,
    ownerId,
    behaviour: seed.behaviour,
    templateKey: input.templateKey,
    title: input.title,
    icon: seed.icon,
    emptyStateCopy: seed.emptyStateCopy,
    capabilities: { ...seed.capabilities },
    /*
     * A list made for one Plan is forced to `slot: null` by the server, so the optimistic row
     * says the same thing rather than briefly claiming to be a standing destination (§P3-05
     * step 3). Without a source Plan the chosen style's slot is what a create writes.
     */
    slot: input.sourceActivityId === undefined ? seed.slot : null,
    ...(input.sourceActivityId === undefined
      ? {}
      : { sourceActivityId: input.sourceActivityId }),
    itemCount: 0,
    uncheckedCount: 0,
    memberCount: 1,
    rankVersion: 0,
    archived: false,
    updatedAt: mintedAt,
    lastItemActivityAt: mintedAt,
  };
}
