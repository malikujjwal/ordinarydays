/** Persisted identifiers. Changing one is a stored-cache migration, not a refactor. */
export const activityMutationKeys = {
  create: ['activity', 'create'],
  duplicate: ['activity', 'duplicate'],
  delete: ['activity', 'delete'],
  patch: ['activity', 'patch'],
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
