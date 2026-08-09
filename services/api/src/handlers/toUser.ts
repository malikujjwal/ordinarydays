import type { User } from '@od/shared/types';

/**
 * The `User` an API response carries — built **field by field, never by spreading**.
 *
 * A stored row carries `pk`, `sk` and `entity` alongside the domain fields, and every future
 * storage attribute will arrive on it too. `return c.json({ data: item })` ships all of them
 * (`agent-playbook.md` §6.11, `data-model.md` §8: "Never expose raw DynamoDB `pk`/`sk` over
 * the API"). A spread with a delete list is the same mistake wearing a hat: it leaks by
 * default and is corrected by remembering.
 *
 * So this names what goes out. A field added to the stored shape does not appear in a
 * response until somebody adds a line here, which is the direction the default should point.
 *
 * `cognitoSub` is deliberately **not** projected. It is Phase 4's internal join key to the
 * user pool and nothing on the client has any use for it.
 */
export function toUser(user: User): Record<string, unknown> {
  return {
    userId: user.userId,
    displayName: user.displayName,
    timezone: user.timezone,
    currency: user.currency,
    weekStartsOn: user.weekStartsOn,
    ...(user.defaultReminderOffset === undefined
      ? {}
      : { defaultReminderOffset: user.defaultReminderOffset }),
    ...(user.allDayReminderHour === undefined
      ? {}
      : { allDayReminderHour: user.allDayReminderHour }),
    ...(user.quietHours === undefined ? {} : { quietHours: user.quietHours }),
    ...(user.defaultLists === undefined ? {} : { defaultLists: user.defaultLists }),
    ...(user.email === undefined ? {} : { email: user.email }),
    ...(user.onboardingState === undefined
      ? {}
      : { onboardingState: user.onboardingState }),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    schemaVersion: user.schemaVersion,
  };
}
