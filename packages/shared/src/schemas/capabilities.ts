import { z } from 'zod';

/** Caller-specific activity action authority, authored by the API. */
export const activityActionCapabilities = z.strictObject({
  complete: z.boolean(),
  skip: z.boolean(),
  snooze: z.boolean(),
});
