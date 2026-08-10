import type { CreationTarget } from '@od/shared/client';
import type { CreateActivityInput } from '@od/shared/schemas';
import { format, parseISO } from 'date-fns';
import {
  type DraftDetails,
  type DraftLocation,
  type DraftSchedule,
  toActivityDetails,
} from '@/features/compose/model/draft';
import { planKindChoices, planKindLabel } from '@/lib/planKinds';

/**
 * The chooser's vocabulary, and the mapping from a chosen target onto a request body
 * (`activities.md` §2.2, §2.5, `interaction-contract.md` §1a.3).
 *
 * Pure: no React, no store, no network. Everything here is a total function of an explicit
 * choice, which is what lets the whole of `CLAUDE.md` rule 2 be asserted without rendering
 * anything.
 *
 * ## What is deliberately absent
 *
 * There is no `inferTarget`, no `defaultTarget`, no `suggestPlanKind`, and no function that
 * takes a title. **Nothing in this module accepts free text.** A helper that mapped words to
 * a kind would be the single change that breaks the product, and the way to keep it from
 * being written by accident is for the module that would host it to have no input to offer.
 */

/** The three rows of the global chooser, in their fixed order. Never reordered by history. */
export type ObjectChoice = 'task' | 'plan' | 'listItem';

/**
 * `Fri, 8 Aug` — the toast table's format in `activities.md` §2.5.
 *
 * Deliberately **not** `@od/ui`'s `formatWallDate`, which renders `Sat, Aug 8` for
 * `design-system.md` §7.3's plan card. Two surfaces, two stated formats; borrowing one for the
 * other would be quietly rewriting whichever doc lost.
 */
const formatWallDate = (date: string): string => format(parseISO(date), 'EEE, d MMM');

export interface Choice<T> {
  value: T;
  label: string;
}

/**
 * `Task`, `Plan`, `List item` — exactly these labels, exactly this order.
 *
 * Frozen so that a caller cannot sort or splice it. The chooser "does not remember, reorder
 * or pre-select the last target"; a mutable module-level array is how the first
 * most-recently-used experiment would get written.
 */
export const objectChoices: readonly Choice<ObjectChoice>[] = Object.freeze([
  { value: 'task', label: 'Task' },
  { value: 'plan', label: 'Plan' },
  { value: 'listItem', label: 'List item' },
]);

/**
 * `General`, `Meal`, `Watch`, `Event`, in order.
 *
 * Re-exported from `@/lib/planKinds` rather than defined here: the detail screen renders the
 * same labels, and a second feature importing this module is exactly what
 * `no-cross-feature-imports` forbids. The reasoning for the move is written out there.
 */
export { planKindChoices, planKindLabel };

/**
 * The header that stays visible on the form: `Task`, or `Plan · Watch`.
 *
 * It is not a suggestion banner and it is not dismissible — the selected object and Plan kind
 * remain visible while the form is filled (`activities.md` §2.4).
 */
export function targetHeading(target: CreationTarget): string {
  if (target.objectKind === 'task') return 'Task';
  if (target.objectKind === 'plan') return `Plan · ${planKindLabel(target.type)}`;
  return 'List item';
}

/**
 * The final button's label. **It names the exact write** (`activities.md` §2.5).
 *
 * A generic `Save` is a defect here, not a simplification: the button is the last moment at
 * which the user can see what is about to be written and where.
 */
export function saveLabel(target: CreationTarget, listName?: string): string {
  if (target.objectKind === 'task') return 'Save task';
  if (target.objectKind === 'plan') return 'Save plan';
  return `Add to ${listName ?? 'list'}`;
}

/**
 * The draft fields that survive a target change.
 *
 * Only the fields common to every type in `activities.md` §4 — which in Phase 1 is all of
 * them, because P1-24 collects title, notes and a source URL and nothing type-specific. The
 * shape is named rather than inlined because **P1-17's field mapping plugs in exactly here**
 * when the forms in P1-25 add type-specific fields, and having the seam already carved is
 * what stops that landing as a rewrite of the store.
 */
export interface CommonDraftFields {
  title: string;
  notes: string;
  sourceUrl?: string;
}

/**
 * The whole draft: the common fields plus everything `activities.md` §4 adds per type (P1-25).
 *
 * `CommonDraftFields` stays as its own interface because it is what survives a target change
 * — the seam P1-24 carved for exactly this moment. Everything below it is type-specific and is
 * mapped by P1-17 when the kind changes, not carried across blindly.
 */
export interface DraftFields extends CommonDraftFields {
  schedule: DraftSchedule;
  location: DraftLocation;
  /** `undefined` is `Off`: no `REM#` row is written (`notifications.md` §2.1). */
  reminderOffset: number | undefined;
  details: DraftDetails;
}

/**
 * Builds the create request from a fixed target plus the common fields.
 *
 * `target` is a required parameter of a union type, so there is no reachable call that omits
 * `objectKind` or `type` — the compiler refuses it before the server ever has to. The
 * `listItem` arm returns `undefined` because a List item is not an Activity and does not go
 * to `POST /v1/activities` at all; Phase 3 gives it `POST /v1/lists/:id/items`.
 */
export function toCreateActivityInput(
  target: CreationTarget,
  fields: DraftFields,
  timezone: string,
): CreateActivityInput | undefined {
  const title = fields.title.trim();
  const notes = fields.notes.trim();
  const { date, time, endTime } = fields.schedule;

  /**
   * `time` requires `date` and `endTime` requires `time` — the schema refuses either on its
   * own (`activities.md` §3 rule 4). The form already disables the controls in that order, so
   * this is belt and braces rather than the only guard, but a draft can reach here with a
   * cleared date and a time the user set before clearing it.
   */
  const schedule =
    date === undefined || date === ''
      ? undefined
      : {
          date,
          ...(time === undefined || time === '' ? {} : { time }),
          ...(time === undefined || time === '' || endTime === undefined || endTime === ''
            ? {}
            : { endTime }),
          timezone,
        };

  /**
   * **A location needs a label.** `activityLocation` makes `label` required and `address`
   * optional, which is the model saying an address on its own does not identify a place.
   *
   * So an address typed with no label sends no location at all rather than a body the server
   * would reject with a field name the user never saw. The form is what stops that being a
   * silent loss: `LocationControl` marks the label required as soon as an address is typed.
   */
  const label = fields.location.label.trim();
  const address = fields.location.address.trim();
  const location =
    label === '' ? undefined : { label, ...(address === '' ? {} : { address }) };

  /**
   * A reminder needs a date to be an offset from, and it is written as the creator's own
   * `REM#` row — never a field on the Activity (ADR-047). `channel` is `'push'` in v1.
   */
  const reminders =
    fields.reminderOffset === undefined || schedule === undefined
      ? undefined
      : [{ offsetMinutes: fields.reminderOffset }];

  const common = {
    title,
    ...(notes === '' ? {} : { notes }),
    ...(fields.sourceUrl === undefined || fields.sourceUrl === ''
      ? {}
      : { sourceUrl: fields.sourceUrl }),
    ...(schedule === undefined ? {} : { schedule }),
    ...(location === undefined ? {} : { location }),
    ...(reminders === undefined ? {} : { reminders }),
  };

  if (target.objectKind === 'task') {
    return {
      ...common,
      objectKind: 'task',
      type: 'task',
      details: toActivityDetails('task', fields.details, title),
    };
  }

  if (target.objectKind === 'plan') {
    return {
      ...common,
      objectKind: 'plan',
      type: target.type,
      /**
       * `details` mirrors the chosen type so the server's `details.kind === type` check has
       * something to agree with. Watch mirrors its required `mediaTitle` from the title,
       * per `activities.md` §4.3.
       */
      details: toActivityDetails(target.type, fields.details, title),
    };
  }

  return undefined;
}

/**
 * Whether the named write action is available (`activities.md` §2.5).
 *
 * A non-empty trimmed title, and nothing else. There is no second required field on any
 * target, because object and Plan kind were already answered before this form opened — which
 * is the whole reason the explicit chooser costs the user nothing.
 */
export function canSave(fields: CommonDraftFields): boolean {
  return fields.title.trim() !== '';
}

/**
 * The success toast (`activities.md` §2.5), all seven rows.
 *
 * P1-24 implemented the two undated rows and said the rest would arrive "with the control that
 * can produce them". That control is `DatePicker`, and this is that task.
 *
 * The past-date row is not an error path: creating with a past date is the **retro-log**
 * path, deliberate and supported, and the copy says `logged for` rather than `planned for`
 * precisely so the user can tell which one happened.
 */
export function successToast(
  target: CreationTarget,
  schedule: DraftSchedule,
  today: string,
): string {
  const noun =
    target.objectKind === 'task'
      ? 'Task'
      : target.objectKind === 'plan'
        ? `${planKindLabel(target.type)} plan`
        : undefined;

  if (noun === undefined) return 'Added to list';

  const date = schedule.date;
  if (date === undefined || date === '') {
    return target.objectKind === 'task'
      ? 'Task · saved to Anytime'
      : `${noun} · saved to Needs a date`;
  }

  // `YYYY-MM-DD` is fixed-width and big-endian, so string order is date order.
  if (date < today) return `${noun} · logged for ${formatWallDate(date)}`;
  if (date === today && target.objectKind === 'task') return 'Task · added to Today';
  return `${noun} · planned for ${formatWallDate(date)}`;
}
