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
