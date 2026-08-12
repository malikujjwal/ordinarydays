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
} as const;

export type ActivityMutationName = keyof typeof activityMutationKeys;
