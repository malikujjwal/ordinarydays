import {
  type Activity,
  type ActivityDetails,
  assertNever,
  type EventReservation,
} from '@od/shared/types';
import { updatesSectionVisible } from '@/features/activity/model/planSections';
import type { PendingActivity } from '@/lib/pendingActivity';

type DisplayActivity = Activity | PendingActivity;

/**
 * The rows of the one `Details` group, in render order (founder, 2026-09-10).
 *
 * The six topic sections (RECIPE / WATCHING / DESCRIPTION / RESERVATION / TICKETS / LINK)
 * and the `Related plan` / `From <list>` setting rows became one label-left / value-right
 * group with a single `Edit`. A row exists only when it holds something; the group exists
 * only when it has at least one row.
 */
export const DETAIL_ROW_KEYS = [
  'recipe',
  'episode',
  'service',
  'booking',
  'tickets',
  'organiser',
  'description',
  'link',
  'partOf',
  'from',
] as const;

export type DetailRowKey = (typeof DETAIL_ROW_KEYS)[number];

/** Envelope facts the Details group needs beyond the Activity itself. */
export interface DetailRowContext {
  /** The detail envelope named this activity's source List. */
  readonly hasSourceList: boolean;
}

const NO_CONTEXT: DetailRowContext = { hasSourceList: false };

/** `Add to this plan` type chips. Each opens a sheet; none is a section of its own. */
export type TypeDetailChipKey = 'ingredients' | 'details';

export interface TypeDetailChip {
  readonly key: TypeDetailChipKey;
  readonly label: string;
}

/** The ruled rows under the `Settings` heading, at the foot of the screen. */
export const SETTINGS_SECTION_KEYS = ['repeat', 'reminders', 'people'] as const;

const MEAL_SLOT_LABEL = {
  breakfast: 'Breakfast',
  lunch: 'Lunch',
  dinner: 'Dinner',
  snack: 'Snack',
} as const;

/**
 * Which sections the detail screen renders, and in which state (P1-26).
 *
 * Pure, so the rule below is a unit test rather than something you have to read a component
 * to discover.
 *
 * ## Task detail is not Plan detail with things hidden
 *
 * [`today-and-tasks.md`](../../../../../docs/01-product/today-and-tasks.md) §5.6 is explicit:
 * a Task shows title, schedule, repeat, reminder, notes and its parent plan, and **renders no
 * disabled placeholders for anything it lacks**. Tasks are solo, so the coordination sections
 * do not exist for them — showing People greyed out on a Task would teach the user that a
 * Task is a lesser Plan, which is the opposite of the model.
 *
 * A Plan is the other way round: `plans-and-lists.md` §2 says a section with nothing in it
 * "collapses to a single add affordance rather than disappearing, so the plan's capabilities
 * stay discoverable".
 *
 * ## The one place two canonical docs disagree, and how it is resolved
 *
 * P1-26's brief lists **Expenses** among the sections that render their `Add …` affordance
 * disabled. `plans-and-lists.md` §2.2 says Expenses is *hidden* when the plan has fewer than
 * two participants and zero expenses — which in Phase 1 is every plan, because nothing can
 * add a participant or an expense yet. The same applies to **Updates**, hidden when the plan
 * is private and has no entries.
 *
 * Resolved in favour of the product doc, per the rule hierarchy in `agent-playbook.md` §2:
 * `01-product/*` owns behaviour and outranks an implementation plan, which is not in that
 * table at all. So Expenses and Updates are absent rather than disabled here. Raised in the
 * PR description rather than settled silently.
 *
 * ## Founder clarification — 2026-08-13
 *
 * Unbuilt Plan capabilities return as **noninteractive discovery rows** saying `Coming later`.
 * They carry neither a disabled Add button nor a chevron, so they show the Plan's intended
 * shape without claiming an action exists.
 */

export interface DetailSection {
  key: string;
  label?: string;
  summary?: string;
  state?: 'coming-later';
}

/**
 * What the plan currently holds, for the sections that exist only once they hold something
 * (P3-37, §2.1 amended 2026-08-25). Counts, not collections: this module decides *which*
 * sections render; `planSections.ts` decides how much of each.
 */
export interface PlanSectionContent {
  readonly childCount: number;
  readonly sourceListCount: number;
  readonly attachmentCount: number;
  /** The picker is reachable (P3-41), so an empty section needs no discovery row. */
  readonly attachmentsWired?: boolean;
  readonly updateCount: number;
  /** The envelope named a source List, so the Details group carries a `From` row. */
  readonly hasSourceList?: boolean;
}

const EMPTY_CONTENT: PlanSectionContent = {
  childCount: 0,
  sourceListCount: 0,
  attachmentCount: 0,
  updateCount: 0,
};

/**
 * The sections for one activity, in render order.
 *
 * **Amended 2026-09-10 (founder): what it is, what it holds, what you wrote, how it
 * behaves.** The header, then `Details`, then the content sections (Ingredients,
 * Preparation, Lists, Attachments), then Notes, then — rendered by the screen, not listed
 * here — the `Add to this …` chip row, then the `Settings` group, then Updates last. This
 * reverses the earlier notes-first order with settings above the type facts.
 *
 * The 2026-08-25 rule still holds: **sections do not exist until they hold something** — no
 * empty PREP heading, no chevron to a blank screen. Empty capabilities are discoverable
 * through the chip row. `People` keeps its pre-build `Coming later` row, now inside Settings.
 */
export function sectionsFor(
  activity: DisplayActivity,
  content: PlanSectionContent = EMPTY_CONTENT,
): DetailSection[] {
  /**
   * `repeat` and `reminders` are **setting rows** and sit together: the two things about
   * *when* this happens, stated by value, each opening its own sheet. Both need a date to
   * hang off — there is nothing to repeat or to count back from without one — so both
   * appear only when the activity is scheduled.
   */
  const schedule =
    activity.schedule === undefined ? [] : [{ key: 'repeat' }, { key: 'reminders' }];

  const details =
    detailRowsFor(activity, { hasSourceList: content.hasSourceList === true }).length > 0
      ? [{ key: 'details', label: 'Details' }]
      : [];

  if (activity.objectKind === 'task') {
    // §5.6's list. The parent plan is a `Part of` Details row, absent when there is none.
    return [
      { key: 'whenWhere' },
      ...details,
      { key: 'notes', label: 'Notes' },
      ...schedule,
    ];
  }

  return [
    { key: 'whenWhere' },
    ...details,
    /**
     * INGREDIENTS (P3-43): a Meal whose stored details carry ingredient rows renders the
     * picker — selection checkboxes, the resolved destination, `Add n to <list>`. A Meal
     * with no rows shows no section; the `Ingredients` chip opens the meal sheet instead.
     */
    ...(activity.type === 'meal' &&
    activity.details.kind === 'meal' &&
    (activity.details.ingredients?.length ?? 0) > 0
      ? [{ key: 'ingredients' as const }]
      : []),
    ...(content.childCount > 0 ? [{ key: 'prep' }] : []),
    ...(content.sourceListCount > 0 ? [{ key: 'lists' }] : []),
    /**
     * Attachments exists once it holds content; while empty it is discovered through the
     * `Photo` chip in the `Add to this plan` row (§2.1 amended, P3-41). The §2.2 pre-build
     * discovery row survives only for a caller that has not wired the picker — the
     * 2026-08-13 clarification's "non-interactive discovery rows ending in `Coming later`"
     * for an unbuilt capability — so an empty plan never loses the signal that it can hold
     * photos.
     */
    ...(content.attachmentCount > 0
      ? [{ key: 'attachments' }]
      : content.attachmentsWired === true
        ? []
        : [
            {
              key: 'attachments-coming-later',
              label: 'Attachments',
              summary: 'Photos and files',
              state: 'coming-later' as const,
            },
          ]),
    { key: 'notes', label: 'Notes' },
    ...schedule,
    {
      key: 'people',
      label: 'People',
      summary: 'Sharing and participants',
      state: 'coming-later',
    },
    // §2.2's one owner of the rule: hidden while private with no entries (P3-40).
    ...(updatesSectionVisible(activity.visibility, content.updateCount)
      ? [{ key: 'updates' }]
      : []),
  ];
}

/**
 * The Details group's rows that currently hold something, in render order. Empty facts are
 * omitted; `shortcutId` is never a row. A movie never shows season or episode.
 *
 * `partOf` exists whenever the activity has a parent — named when the envelope could title
 * it, `A plan` otherwise. A task or plan with no parent has **no** row: the old
 * `Related plan · None` disclosure is gone.
 */
export function detailRowsFor(
  activity: DisplayActivity,
  context: DetailRowContext = NO_CONTEXT,
): DetailRowKey[] {
  const keys: DetailRowKey[] = [];
  const { details } = activity;
  switch (details.kind) {
    case 'meal':
      if (details.recipeUrl !== undefined) keys.push('recipe');
      break;
    case 'watch':
      if (watchEpisodeVisible(details)) keys.push('episode');
      if (presentFreeText(details.service)) keys.push('service');
      break;
    case 'event':
      if (reservationVisible(details.reservation)) keys.push('booking');
      if (details.priceCents !== undefined || details.ticketUrl !== undefined) {
        keys.push('tickets');
      }
      if (presentFreeText(details.organiser)) keys.push('organiser');
      if (presentFreeText(details.description)) keys.push('description');
      break;
    case 'task':
    case 'custom':
      break;
    default:
      assertNever(details, 'ActivityDetails');
  }
  if (shownSourceUrl(activity) !== undefined) keys.push('link');
  if (activity.parentActivityId !== undefined) keys.push('partOf');
  if (context.hasSourceList) keys.push('from');
  return keys;
}

/**
 * The type chips for the `Add to this …` row (2026-09-10). Only two, and only where the
 * thing they add is otherwise unreachable:
 *
 * - `Ingredients` on a Meal with no ingredient rows — opens the meal sheet.
 * - `Details` on any kind whose Details group is absent — the type sheet on a Meal / Watch /
 *   Event, the common Place + Address + Link sheet on a Task / General (amended 2026-09-11:
 *   this chip was `Link` until Place became editable after creation).
 *
 * Once the Details group exists, its one `Edit` reaches every type fact, so no per-fact
 * chip (`Recipe`, `Episode`, `Booking`, …) is offered alongside it.
 */
export function typeDetailChips(
  activity: DisplayActivity,
  context: DetailRowContext = NO_CONTEXT,
): readonly TypeDetailChip[] {
  const detailsPresent = detailRowsFor(activity, context).length > 0;
  const { details } = activity;
  const chips: TypeDetailChip[] = [];
  switch (details.kind) {
    case 'meal':
      if ((details.ingredients?.length ?? 0) === 0) {
        chips.push({ key: 'ingredients', label: 'Ingredients' });
      }
      if (!detailsPresent) chips.push({ key: 'details', label: 'Details' });
      break;
    case 'watch':
    case 'event':
      if (!detailsPresent) chips.push({ key: 'details', label: 'Details' });
      break;
    case 'task':
    case 'custom':
      if (!detailsPresent) chips.push({ key: 'details', label: 'Details' });
      break;
    default:
      assertNever(details, 'ActivityDetails');
  }
  return chips;
}

/**
 * The pasted link is not shown twice. Saving it into `recipeUrl` or `ticketUrl` is the
 * common path; two host rows for one destination is the reported bug.
 */
export function shownSourceUrl(activity: DisplayActivity): string | undefined {
  const url = activity.sourceUrl;
  if (url === undefined) return undefined;
  const { details } = activity;
  if (details.kind === 'meal' && details.recipeUrl === url) return undefined;
  if (details.kind === 'event' && details.ticketUrl === url) return undefined;
  return url;
}

/** `freeText` allows `''`; blank is the same as absent for type-fact visibility. */
function presentFreeText(value: string | undefined): value is string {
  return value !== undefined && value !== '';
}

function watchEpisodeVisible(
  details: Extract<ActivityDetails, { kind: 'watch' }>,
): boolean {
  if (details.mediaKind !== 'movie') {
    if (details.season !== undefined || details.episode !== undefined) return true;
  }
  return presentFreeText(details.episodeTitle);
}

function reservationVisible(reservation: EventReservation | undefined): boolean {
  if (reservation === undefined) return false;
  return (
    presentFreeText(reservation.name) ||
    reservation.time !== undefined ||
    reservation.partySize !== undefined ||
    presentFreeText(reservation.reference)
  );
}

/**
 * The header's second line: `Meal · Dinner · Just you`, `Watch · S2 E4 · Just you`, `Task`.
 *
 * Identity belongs here (`design-system.md` §7.5 rule 1). Slot / both-set watch progress /
 * organiser ride in the middle when set. A movie never contributes season or episode, even
 * if stored. Partial watch progress does not become `S3` — that is a held founder call, so
 * the line falls back to mediaKind. An event without organiser does not fall back to
 * locationLabel; the location already renders below. Today-row `deriveSubtitle` copies are
 * untouched.
 *
 * Phase 1 has no participants, so the share state is always "just you" on a Plan and is
 * omitted entirely on a Task — a Task has no sharing state to describe, not even a solo one
 * (`today-and-tasks.md` §5.1).
 */
export function subtitleFor(activity: DisplayActivity, planKindLabel: string): string {
  if (activity.objectKind === 'task') return 'Task';
  const parts = [planKindLabel];
  const middle = subtitleMiddle(activity.details);
  if (middle !== undefined) parts.push(middle);
  parts.push('Just you');
  return parts.join(' · ');
}

function subtitleMiddle(details: ActivityDetails): string | undefined {
  if (details.kind === 'meal') {
    return details.mealSlot === undefined ? undefined : MEAL_SLOT_LABEL[details.mealSlot];
  }
  if (details.kind === 'watch') {
    if (
      details.mediaKind !== 'movie' &&
      details.season !== undefined &&
      details.episode !== undefined
    ) {
      return `S${details.season} E${details.episode}`;
    }
    if (details.mediaKind === 'movie') return 'Movie';
    if (details.mediaKind === 'show') return 'Show';
    return undefined;
  }
  if (details.kind === 'event') {
    return presentFreeText(details.organiser) ? details.organiser : undefined;
  }
  return undefined;
}

/**
 * Whether the `⋯` menu offers the Plan → Task conversion, and what blocks it.
 *
 * `activities.md` §6.3 rule 3: available only at zero participants, zero expenses and zero
 * prep children; otherwise blocked, naming exactly what must be removed first. The counts
 * come off the Activity's own denormalised fields, so this needs no extra read.
 *
 * Phase 1 can only ever produce zeroes — but the rule is implemented against the counts
 * rather than hard-coded to `true`, because the moment P6 adds a participant this must
 * already be right. A function that returned "always allowed" would be correct today and
 * silently wrong on the first shared plan.
 */
export function planToTaskBlockers(activity: Activity): string[] {
  const blockers: string[] = [];
  if (activity.participantCount > 0) {
    blockers.push(
      `${activity.participantCount} ${activity.participantCount === 1 ? 'person' : 'people'}`,
    );
  }
  if (activity.expenseTotalCents !== 0) blockers.push('1 expense');
  if (activity.childCount > 0) {
    blockers.push(
      `${activity.childCount} prep ${activity.childCount === 1 ? 'task' : 'tasks'}`,
    );
  }
  return blockers;
}

/** `Remove 2 people and 1 expense before changing this to a Task.` (§6.3 rule 3). */
export function planToTaskBlockedMessage(blockers: string[]): string | undefined {
  if (blockers.length === 0) return undefined;
  const list =
    blockers.length === 1
      ? blockers[0]
      : `${blockers.slice(0, -1).join(', ')} and ${blockers[blockers.length - 1]}`;
  return `Remove ${list} before changing this to a Task.`;
}
