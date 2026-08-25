import type { Cents, Hhmm, IanaTimezone, IsoDate, UserId } from '../schemas/common.js';
import type { Recurrence } from './recurrence.js';
import type {
  ActivityObjectKind,
  ActivityOutcome,
  ActivityStatus,
  ActivityType,
  ActivityVisibility,
  PlanType,
} from './vocabulary.js';

/**
 * The one schedulable entity (`data-model.md` §4.1, `CLAUDE.md` rule 1).
 *
 * Task, Meal, Watch, Event and Custom are a `type` field, not five tables. A "Plan" is
 * an Activity the user intends to make happen, with or without a date yet; "Today" is a
 * query, not storage.
 *
 * **There is no `reminders[]` field here, and there must never be one.** Reminders are
 * per-user items in the same partition (`../types/reminder.ts`). `CreateActivityInput` has a
 * `reminders` field, and the two are deliberately different shapes: the input writes rows for
 * the **creator**, and the stored Activity holds none. They must not share a type — that is
 * how a Phase 6 leak gets built in Phase 1 and only noticed once it is stored data. ADR-047.
 */

/** Where and when. Its presence is a scheduling state, never an identity (`data-model.md` §1). */
export interface ActivitySchedule {
  date: IsoDate;
  /** Absent means all-day / anytime that day. */
  time?: Hhmm;
  endTime?: Hhmm;
  timezone: IanaTimezone;
  /** Derived from date + time + timezone. Absent for all-day. Never authoritative over the three. */
  scheduledAtUtc?: string;
  endAtUtc?: string;
}

export interface ActivityLocation {
  label: string;
  address?: string;
  /** Populated only by capture extraction (Phase 8) or a pasted maps URL. v1 has no geocoding. */
  lat?: number;
  lng?: number;
  mapUrl?: string;
}

export interface MealIngredient {
  /**
   * A client-minted `ing_` embedded-row identity, not an entity id (`data-model.md` §8).
   *
   * Minted before a new row is accepted and retained through edits and reordering, so an
   * add-to-list action can name the same row after the array moves. Replacing a row mints a
   * new one; removing it makes the old one stale.
   */
  ingredientId: string;
  name: string;
  quantity?: string;
  /** Set when the row has been sent to a list. Server-owned; written only by P3-17. */
  addedToListId?: string;
}

export interface EventReservation {
  name?: string;
  time?: Hhmm;
  partySize?: number;
  reference?: string;
}

/**
 * Type-specific fields (`data-model.md` §4.4), discriminated on `kind`.
 *
 * **`details.kind` always equals `activity.type`**, asserted at the schema boundary. That
 * refinement is what makes "a meal with watch fields" unrepresentable rather than merely
 * discouraged.
 */
export type ActivityDetails =
  | { kind: 'task' }
  | {
      kind: 'meal';
      mealSlot?: 'breakfast' | 'lunch' | 'dinner' | 'snack';
      ingredients?: MealIngredient[];
      recipeUrl?: string;
    }
  | {
      kind: 'watch';
      mediaTitle: string;
      mediaKind?: 'movie' | 'show';
      season?: number;
      episode?: number;
      episodeTitle?: string;
      /** Free text: "Netflix", "Apple TV+". Not an enum — the list is not ours to close. */
      service?: string;
    }
  | {
      kind: 'event';
      /** Public on the invite page, unlike `notes`, which never leaves the owner's view. */
      description?: string;
      priceCents?: Cents;
      currency?: string;
      ticketUrl?: string;
      organiser?: string;
      reservation?: EventReservation;
    }
  | { kind: 'custom'; shortcutId?: string };

export interface ActivityBase {
  activityId: string;
  ownerId: UserId;
  /** Derived on write, never taken freely from the client (`data-model.md` §4.1 rules). */
  status: ActivityStatus;

  title: string;
  notes?: string;

  schedule?: ActivitySchedule;
  recurrence?: Recurrence;

  location?: ActivityLocation;

  parentActivityId?: string;
  listItemId?: string;
  listId?: string;
  sourceUrl?: string;
  primaryAttachmentId?: string;

  /** Denormalised, maintained on write. Also the three Plan → Task conversion blockers. */
  participantCount: number;
  childCount: number;
  expenseTotalCents: number;

  /** `shared` only once the user explicitly shares. Removing the last participant leaves it. */
  visibility: ActivityVisibility;

  details: ActivityDetails;

  completedAt?: string;
  /** One-off snooze only; recurring snoozes live on Occurrence overrides. */
  snoozedUntil?: string;
  outcome?: ActivityOutcome;

  /**
   * RFC 5545 `SEQUENCE`, from 0. Increments **only** for fields that appear in an exported
   * calendar event — title, schedule, location, cancellation, description — never for notes,
   * expenses, participants or attachments. Calendar clients ignore an update whose sequence
   * did not advance.
   */
  icsSequence: number;

  createdAt: string;
  /** Discussion activity; sorts undated Plans without invalidating edit concurrency. */
  lastActivityAt: string;
  updatedAt: string;
  schemaVersion: 1;
}

/**
 * The explicit creation target, carried on every stored Activity.
 *
 * `objectKind` is selected by the user and is the sole source of truth for Task versus Plan.
 * It is never inferred from `schedule`, `type`, `participantCount`, title text or capture
 * output, and it changes only when a `PATCH` explicitly carries it (`CLAUDE.md` rule 2).
 *
 * `data-model.md` §4.1 writes this as `ActivityBase & ({…} | {…})`. It is spelled here as two
 * interfaces extending the base instead, which is the same shape and one the compiler treats
 * as **flat** rather than as an intersection — `expectTypeOf(...).toEqualTypeOf(...)` against
 * the Zod-inferred type distinguishes the two, and the intersection form does not match.
 * Naming the arms also gives P1-17's kind-change mapping something to speak in.
 */
export interface TaskActivity extends ActivityBase {
  objectKind: 'task';
  type: 'task';
}

export interface PlanActivity extends ActivityBase {
  objectKind: 'plan';
  type: PlanType;
}

export type Activity = TaskActivity | PlanActivity;

export type { ActivityObjectKind, ActivityType, PlanType };

/**
 * The stages `GET /v1/activities?filter=` serves (`api-contract.md` §2.2).
 *
 * Each maps to exactly one GSI1 bucket, which is what lets a page be one Query with one
 * cursor. See the schema of the same name for the P1-16 amendment that removed `inbox` and
 * split `saved` from `needs_date`, and why.
 */
export type ActivityFilter = 'upcoming' | 'past' | 'saved' | 'needs_date';

/**
 * One row of a flat list — the projection of a `USER#<u>` / `IDX#<a>` entry.
 *
 * **Not `AgendaItem`.** That shape carries `occurrenceDate`, `isSnoozed`, `isPast` and
 * `overdueFromDate`, all of which exist only after recurrence expansion — the agenda's work,
 * and Phase 2's to define. This endpoint expands nothing and answers with what the index row
 * holds.
 */
export interface ActivityListItem {
  activityId: string;
  type: ActivityType;
  title: string;
  status: ActivityStatus;
  /** `HH:mm`, when the activity has a clock time. */
  time?: string;
  endTime?: string;
  /** One row per series, never one per occurrence (`CLAUDE.md` rule 3). */
  isRecurring: boolean;
  participantCount: number;
  locationLabel?: string;
  /** `Meal · Dinner`, `Watch · S2 E4`, a place name, or a prep task's parent plan title. */
  subtitle?: string;
}
