/** Server-authored Updates feed for one Activity. */
export const activityUpdatesKey = (activityId: string) =>
  ['activity', activityId, 'updates'] as const;
