/** Persisted identifiers. Changing one is a stored-cache migration, not a refactor. */
export const activityMutationKeys = {
  create: ['activity', 'create'],
  duplicate: ['activity', 'duplicate'],
  delete: ['activity', 'delete'],
  patch: ['activity', 'patch'],
  convertRecurrence: ['activity', 'convert-recurrence'],
  schedule: ['activity', 'schedule'],
  complete: ['activity', 'complete'],
  uncomplete: ['activity', 'uncomplete'],
  skip: ['activity', 'skip'],
  snooze: ['activity', 'snooze'],
  unsnooze: ['activity', 'unsnooze'],
  reminderCreate: ['activity', 'reminder-create'],
  reminderDelete: ['activity', 'reminder-delete'],
} as const;

export type ActivityMutationName = keyof typeof activityMutationKeys;

/** Durable update-feed writes do not alter Agenda row topology. */
export const activityUpdateMutationKeys = {
  post: ['activity', 'update-post'],
  delete: ['activity', 'update-delete'],
} as const;

/** Persisted List mutation identifiers and the one source of truth for their wire tags. */
export const listMutationKeys = {
  create: ['list', 'create'],
  patch: ['list', 'patch'],
  delete: ['list', 'delete'],
  undo: ['list', 'undo'],
  itemCreate: ['list', 'item-create'],
  itemPatch: ['list', 'item-patch'],
  itemDelete: ['list', 'item-delete'],
  itemUndo: ['list', 'item-undo'],
  /**
   * The `Plan this item` bridge (P3-34, §P3-13). A `list` key because the route is
   * list-scoped and the intent must order behind the item's own creation in the list's lane —
   * but its **entity is the minted Activity**, and settlement installs an Activity, not a
   * list row. The item itself stays byte-identical, which is why this key is deliberately
   * absent from `listItemProjectionMutationKeys`.
   */
  itemSchedule: ['list', 'item-schedule'],
} as const;

export type ListMutationName = keyof typeof listMutationKeys;
export type ListMutationKey = (typeof listMutationKeys)[ListMutationName];

interface PersistedMutationDescriptor {
  readonly mutationKey: readonly string[];
}

export function isListMutation(
  intent: PersistedMutationDescriptor,
  name: ListMutationName,
): boolean {
  const expected = listMutationKeys[name];
  return intent.mutationKey[0] === expected[0] && intent.mutationKey[1] === expected[1];
}

export const listItemProjectionMutationKeys = [
  listMutationKeys.itemCreate,
  listMutationKeys.itemPatch,
  listMutationKeys.itemDelete,
  listMutationKeys.itemUndo,
] as const;

export function isListItemProjectionMutation(
  intent: PersistedMutationDescriptor,
): boolean {
  return listItemProjectionMutationKeys.some(
    (key) => intent.mutationKey[0] === key[0] && intent.mutationKey[1] === key[1],
  );
}

/**
 * The wire tag in `['activity', <tag>]` — the discriminant every projector switches on.
 *
 * Derived from the table above rather than written out, so adding a key here forces every
 * exhaustive `switch` over it to fail compilation until the new write says what it does to the
 * cached agenda. That is deliberate: `refreshActivityLists` marks the agenda stale with
 * `refetchType: 'none'`, which is only safe while **every** write projects. A key that opts
 * into the stale-marking and forgets the projection leaves Today wrong with nothing to correct
 * it — which is exactly how `patch` and `delete` came to sit unprojected.
 */
export type ActivityMutationTag = (typeof activityMutationKeys)[ActivityMutationName][1];

interface ActivityMutationDescriptor {
  readonly mutationKey: readonly unknown[];
  readonly variables: unknown;
}

/**
 * Whether one durable Activity mutation changes recurrence topology.
 *
 * Sync reconciliation and row presentation intentionally share this predicate: while the
 * server and local projections may temporarily retain the old occurrence rows, those rows must
 * stay inert until the topology response has been installed. Keeping the persisted mutation
 * tags here prevents `convert-recurrence` and recurrence-bearing patches from drifting apart.
 */
export function changesRecurrenceTopology({
  mutationKey,
  variables,
}: ActivityMutationDescriptor): boolean {
  if (mutationKey[0] !== 'activity') return false;
  if (mutationKey[1] === 'convert-recurrence') return true;
  if (mutationKey[1] !== 'patch') return false;
  if (typeof variables !== 'object' || variables === null) return false;
  const input = (variables as { readonly input?: unknown }).input;
  return (
    typeof input === 'object' && input !== null && Object.hasOwn(input, 'recurrence')
  );
}
