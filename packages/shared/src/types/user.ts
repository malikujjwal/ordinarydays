import type { Hhmm, IanaTimezone, IsoDate, UserId } from '../schemas/common.js';

/**
 * The user profile — `USER#<userId>` / `PROFILE` (`data-model.md` §3.2, §4.0).
 *
 * **This is the tenant record.** Every item in the product is keyed by the `userId` on it,
 * so this shape is load-bearing from the first line of repository code even though nothing
 * creates a profile until Phase 4 (P1-21's seed writes the one local dev row).
 *
 * The whole shape is here, including fields no Phase 1 code reads. That is deliberate and
 * P1-07 states the reason: "every field Phase 4 needs — `email`, `cognitoSub`,
 * `onboardingState` — exists in the type from this phase and is simply absent or defaulted
 * on the seeded record. Phase 4 populates them; it does not add them." Adding a field to a
 * stored shape later is a migration; declaring it optional now is a line.
 */

/** How far a list of days starts. `0` = Sunday, matching `byWeekday` in `Recurrence`. */
export type WeekStart = 0 | 1;

/**
 * Where onboarding got to. A real new profile starts `new`; the seeded dev profile is
 * `done` so no local screen sits behind an onboarding gate that has nothing to configure.
 */
export type OnboardingState = 'new' | 'done';

/**
 * A semantic destination for "add these to a list" flows, not a behaviour
 * (`data-model.md` §4.6 "Default slots"). Once `groceries` and `packing` are both
 * `collection`, behaviour alone cannot say which one an ingredient should go to.
 */
export type DefaultSlot = 'groceries' | 'watch' | 'meals';

/** Local wall-clock window during which push is held (`notifications.md` §4). Phase 5. */
export interface QuietHours {
  enabled: boolean;
  /** Inclusive start, local. Crosses midnight when `start > end` — 22:00–07:00 is normal. */
  start: Hhmm;
  end: Hhmm;
}

export interface User {
  userId: UserId;
  displayName: string;
  timezone: IanaTimezone;
  /** ISO 4217. Expenses are never converted between currencies (`data-model.md` §3.2). */
  currency: string;
  weekStartsOn: WeekStart;

  /**
   * The user's saved default reminder offset, in minutes before the start.
   *
   * **Three states, and the difference matters** (`notifications.md` §2, ADR-047):
   * a negative number is "that many minutes before"; `0` is a real *At the time* reminder;
   * `null`/absent is **Off** and creates no `REM#` row at all. A new account ships Off. The
   * `0`-versus-absent distinction is why this is nullable rather than merely optional — a
   * schema that collapsed them would silently turn "at the time" into "no reminder".
   */
  defaultReminderOffset?: number | null;

  /** Hour of the day an all-day activity's reminder fires. Local. */
  allDayReminderHour?: number;

  /** Phase 5 (P5-11). Absent until the user changes a toggle; defaults are never stored. */
  quietHours?: QuietHours;

  /**
   * Chosen destination per slot, so "add these ingredients" has somewhere to go without
   * asking every time (`data-model.md` §4.6). Populated from Phase 3; typed now so the
   * profile shape does not change when it is.
   *
   * **Stored values are never null.** Clearing a slot removes the key, so a slot is either a
   * list id or absent and there is no third state to interpret. {@link PatchUserInput} is
   * the nullable one, and the asymmetry is the point (P3-12).
   */
  defaultLists?: Partial<Record<DefaultSlot, string>>;

  /**
   * Phase 4. Written by the post-confirmation trigger, which is the only thing that ever
   * creates a profile (`auth.md`). Absent on the seeded local dev row, which has no account
   * behind it.
   */
  email?: string;
  cognitoSub?: string;
  onboardingState?: OnboardingState;

  createdAt: IsoDate | string;
  updatedAt: IsoDate | string;
  schemaVersion: 1;
}

/**
 * What `PATCH /v1/me` accepts — and nothing else (`api-contract.md` §2.1).
 *
 * Deliberately a small subset of {@link User}. `email`, `cognitoSub` and `onboardingState`
 * are set by the auth flow, not by the user; `createdAt`/`schemaVersion` are storage. A
 * patch naming any of them is `400`, which is a property P1-07 tests rather than assumes.
 */
export interface PatchUserInput {
  displayName?: string;
  timezone?: IanaTimezone;
  currency?: string;
  weekStartsOn?: WeekStart;
  /** `null` clears the default to Off. Absent means "leave it alone". */
  defaultReminderOffset?: number | null;
  /**
   * A **nested per-slot patch**, not a replacement of the stored map (`api-contract.md`
   * §2.1, P3-12).
   *
   * Each slot is independent: omitted preserves it, a `lst_` id sets it, `null` removes just
   * that key. Two devices setting different slots concurrently therefore both win, which is
   * the property a whole-map assignment would quietly destroy — the second write would carry
   * the first device's stale siblings and undo its choice.
   */
  defaultLists?: Partial<Record<DefaultSlot, string | null>>;
}
