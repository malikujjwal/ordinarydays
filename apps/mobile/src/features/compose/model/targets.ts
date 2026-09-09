import type { CreationTarget } from '@od/shared/client';
import {
  type CreateActivityInput,
  type CreateListItemInput,
  createRecurrence,
  type ScheduleListItemInput,
} from '@od/shared/schemas';
import type { Recurrence } from '@od/shared/types';
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
export type ObjectChoice = 'task' | 'plan' | 'list';

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
  /**
   * One line saying what the row is for (founder, 2026-08-16, copy supplied verbatim in the
   * `CREATE/01` frame).
   *
   * It never carries an example of *content* — `Buy milk`, `Dinner with Alice` — because a row
   * that shows what people usually put there is a row that nudges. It says what the **object**
   * is, which is the distinction the whole chooser exists to make explicit.
   */
  subtitle: string;
}

/**
 * `Task`, `Plan`, `Add list` — exactly these labels, exactly this order.
 *
 * Frozen so that a caller cannot sort or splice it. The chooser "does not remember, reorder
 * or pre-select the last target"; a mutable module-level array is how the first
 * most-recently-used experiment would get written.
 */
export const objectChoices: readonly Choice<ObjectChoice>[] = Object.freeze([
  { value: 'task', label: 'Task', subtitle: 'Something you need to do' },
  { value: 'plan', label: 'Plan', subtitle: 'Something you intend to make happen' },
  {
    value: 'list',
    label: 'Add list',
    subtitle: 'A collection for things you want to keep track of',
  },
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

/** Global Add's final button. Contextual entries keep {@link saveLabel}. */
export function createLabel(choice: ObjectChoice): string {
  if (choice === 'task') return 'Create task';
  if (choice === 'plan') return 'Create plan';
  return 'Create list';
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
  recurrence?: Recurrence;
  details: DraftDetails;
  /**
   * The parent Plan fixed by `+ Add prep task` (P3-38). Only a Task may carry one, and only
   * that labelled contextual action supplies it — never a word in the title.
   */
  parentActivityId?: string;
  /**
   * Photos already uploaded by the form's picker (P3-41). The create carries their ids and
   * P3-22 confirms them server-side; an empty list sends nothing.
   */
  attachmentIds?: readonly string[];
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

  const recurrence =
    fields.recurrence === undefined || schedule === undefined
      ? undefined
      : createRecurrence.parse(fields.recurrence);

  const common = {
    title,
    ...(notes === '' ? {} : { notes }),
    ...(fields.sourceUrl === undefined || fields.sourceUrl === ''
      ? {}
      : { sourceUrl: fields.sourceUrl }),
    ...(schedule === undefined ? {} : { schedule }),
    ...(location === undefined ? {} : { location }),
    ...(reminders === undefined ? {} : { reminders }),
    ...(recurrence === undefined ? {} : { recurrence }),
    ...(fields.attachmentIds === undefined || fields.attachmentIds.length === 0
      ? {}
      : { attachmentIds: [...fields.attachmentIds] }),
  };

  if (target.objectKind === 'task') {
    return {
      ...common,
      objectKind: 'task',
      type: 'task',
      // The prep relationship (P3-38): present only when the plan's own action fixed it.
      ...(fields.parentActivityId === undefined
        ? {}
        : { parentActivityId: fields.parentActivityId }),
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
 * Builds the `Plan this item` bridge request from the same draft the form collected (P3-34).
 *
 * A projection of {@link toCreateActivityInput}: identical field rules — trimmed title,
 * schedule ⊃ time ⊃ end time, labelled location, dated reminders — expressed in the
 * bridge contract's shape. `creationTarget` and `audience` are **parameters**, not defaults:
 * both were explicit taps, and this function cannot be called without them
 * (`CLAUDE.md` rule 2).
 *
 * `mintReminderId` is injected because this offline-capable route identifies reminders by
 * client-minted `rem_` ids (§P3-13); the caller owns id generation so a transport retry
 * reuses the ids already persisted, never fresh ones.
 */
export function toScheduleListItemInput(
  target: Extract<CreationTarget, { objectKind: 'plan' }>,
  fields: DraftFields,
  timezone: string,
  activityId: string,
  audience: { mode: 'just_me' },
  mintReminderId: () => string,
): ScheduleListItemInput | undefined {
  const created = toCreateActivityInput(target, fields, timezone);
  if (created === undefined || created.objectKind !== 'plan') return undefined;
  const { objectKind, type, reminders, activityId: _ignored, ...common } = created;
  return {
    ...common,
    activityId,
    creationTarget: { objectKind, type },
    audience,
    ...(reminders === undefined
      ? {}
      : {
          reminders: reminders.map((reminder) => ({
            reminderId: reminder.reminderId ?? mintReminderId(),
            offsetMinutes: reminder.offsetMinutes,
          })),
        }),
  };
}

/**
 * Builds the item request from a fixed List-item target (P3-27).
 *
 * The counterpart to {@link toCreateActivityInput}, and separate for the reason that one
 * returns `undefined` for this arm: a List item is not an Activity, goes to a list-scoped
 * route, and carries none of the schedule, reminder or recurrence a form collects for one.
 *
 * **Title and note only.** Location and the typed per-behaviour fields belong to the item
 * sheet (P3-29) and §5.7's capability rules; sending them from a form that never asked the
 * list what it supports is how a `collection` acquires a season number.
 *
 * `itemId` is the caller's minted `itm_`, because the native path names the row before the
 * server has seen it. The list is **not** a parameter here — it is the path id, taken from
 * the target the user explicitly chose, so there is nowhere in this function for a default
 * destination to enter (criterion 33).
 */
export function toCreateListItemInput(
  target: CreationTarget,
  fields: CommonDraftFields,
  itemId?: string,
): CreateListItemInput | undefined {
  if (target.objectKind !== 'listItem') return undefined;
  const title = fields.title.trim();
  const notes = fields.notes.trim();
  return {
    ...(itemId === undefined ? {} : { itemId }),
    title,
    ...(notes === '' ? {} : { note: notes }),
  };
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
