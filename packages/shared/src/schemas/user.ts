import { z } from 'zod';
import { hhmm, ianaTimezone, ulidId, userId } from './common.js';

/**
 * The user profile, as a schema (`data-model.md` §4.0, `api-contract.md` §2.1).
 *
 * The interface lives in `../types/user.ts`; this file is the runtime check. Neither
 * restates the other, and `user.test.ts` asserts in both directions that they describe the
 * same shape — the pattern `schemas/error.ts` established.
 */

/** `0` = Sunday. Matches `byWeekday` in `Recurrence`, so the two never disagree. */
export const weekStart = z.union([z.literal(0), z.literal(1)]);

export const onboardingState = z.enum(['new', 'done']);

export const defaultSlot = z.enum(['groceries', 'watch', 'meals']);

export const quietHours = z.object({
  enabled: z.boolean(),
  start: hhmm,
  end: hhmm,
});

/**
 * Minutes before the start, `[-10080, 0]` — a week at most, and never positive
 * (`api-contract.md` §2.1).
 *
 * **Nullable on purpose.** `0` is a real *At the time* reminder and `null` is Off; a schema
 * that accepted only `undefined` for Off would make the two indistinguishable on the wire,
 * and a joiner would silently get no reminder where they had asked for one at the time
 * (ADR-047).
 */
export const defaultReminderOffset = z
  .number()
  .int('A reminder offset is a whole number of minutes')
  .min(-10080, 'A reminder cannot be more than a week before')
  .max(0, 'A reminder cannot be after the start');

/** ISO 4217, upper case. Not an enum: the currency list is not ours to close. */
export const currencyCode = z
  .string()
  .length(3)
  .regex(/^[A-Z]{3}$/, 'Expected an ISO 4217 currency code, e.g. USD');

/**
 * The **stored** slot map: resolved list ids only, and never a null.
 *
 * Clearing a slot removes the key rather than writing an empty value, so there is no third
 * state for a reader to interpret — a slot is either set to a list or absent
 * (`data-model.md` §4.6). The patch input below is the nullable one, and the two are
 * deliberately different shapes.
 */
export const storedDefaultLists = z.partialRecord(defaultSlot, ulidId('lst'));

/**
 * The **patch** slot map: a nested per-slot patch, not a replacement of the stored map
 * (`api-contract.md` §2.1, `phase-03` §P3-12).
 *
 * Each of the three keys is independent. An omitted slot is preserved untouched, a `lst_`
 * id sets just that slot, and `null` removes just that key. Sending
 * `{ groceries: 'lst_…' }` therefore does not clear `watch` — which is the whole reason the
 * repository applies these through document paths instead of assigning the map.
 */
export const patchDefaultLists = z.partialRecord(defaultSlot, ulidId('lst').nullable());

export const user = z
  .object({
    userId,
    displayName: z.string().min(1).max(120),
    timezone: ianaTimezone,
    currency: currencyCode,
    weekStartsOn: weekStart,
    defaultReminderOffset: defaultReminderOffset.nullable().optional(),
    allDayReminderHour: z.number().int().min(0).max(23).optional(),
    quietHours: quietHours.optional(),
    defaultLists: storedDefaultLists.optional(),
    email: z.email().optional(),
    cognitoSub: z.string().min(1).optional(),
    onboardingState: onboardingState.optional(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    schemaVersion: z.literal(1),
  })
  .meta({ id: 'User' });

/**
 * `PATCH /v1/me`. **Strict**, so a field the endpoint does not accept is a `400` naming it
 * rather than a silent no-op — `email` and `onboardingState` belong to the auth flow, and a
 * client that tried to set them should be told, not ignored.
 */
export const patchUserInput = z
  .strictObject({
    displayName: z.string().min(1).max(120).optional(),
    timezone: ianaTimezone.optional(),
    currency: currencyCode.optional(),
    weekStartsOn: weekStart.optional(),
    defaultReminderOffset: defaultReminderOffset.nullable().optional(),
    defaultLists: patchDefaultLists.optional(),
  })
  .meta({ id: 'PatchUserInput' });
