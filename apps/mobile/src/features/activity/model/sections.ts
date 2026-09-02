import type { Activity } from '@od/shared/types';
import { updatesSectionVisible } from '@/features/activity/model/planSections';
import type { PendingActivity } from '@/lib/pendingActivity';

type DisplayActivity = Activity | PendingActivity;

/**
 * Which sections the detail screen renders, and in which state (P1-26).
 *
 * Pure, so the rule below is a unit test rather than something you have to read a component
 * to discover.
 *
 * ## Task detail is not Plan detail with things hidden
 *
 * [`today-and-tasks.md`](../../../../../docs/01-product/today-and-tasks.md) §5.6 is explicit:
 * a Task shows title, schedule, repeat, reminder, notes and `Related plan`, and **renders no
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
 * shape without claiming an action exists. Ingredients joins those rows for Meal plans: the
 * activity model already stores them, while the interactive detail flow is owned by Phase 3.
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
 * Notes-first order is the founder's 2026-08-13 refinement to the canonical detail anatomy.
 * The 2026-08-25 amendment reshaped the Plan half: **settings always render; sections do not
 * exist until they hold something** — no empty PREP heading, no chevron to a blank screen.
 * Empty capabilities are discoverable through the `Add to this plan` chip row the screen
 * renders after these. `People` keeps its pre-build `Coming later` row (that treatment is
 * explicitly unchanged by the amendment), as does Meal's Ingredients until P3-43 wires it.
 */
export function sectionsFor(
  activity: DisplayActivity,
  content: PlanSectionContent = EMPTY_CONTENT,
): DetailSection[] {
  /**
   * `repeat` and `reminders` are **setting rows** and sit together, in the frames' order:
   * the two things about *when* this happens, stated by value, each opening its own sheet.
   * Both need a date to hang off — there is nothing to repeat or to count back from without
   * one — so both appear only when the activity is scheduled.
   */
  const schedule =
    activity.schedule === undefined ? [] : [{ key: 'repeat' }, { key: 'reminders' }];

  if (activity.objectKind === 'task') {
    // §5.6's list, and nothing else. No placeholders.
    return [
      { key: 'whenWhere' },
      { key: 'notes', label: 'Notes' },
      ...schedule,
      { key: 'relatedPlan', label: 'Related plan' },
    ];
  }

  return [
    { key: 'whenWhere' },
    { key: 'notes', label: 'Notes' },
    ...schedule,
    {
      key: 'people',
      label: 'People',
      summary: 'Sharing and participants',
      state: 'coming-later',
    },
    ...(content.childCount > 0 ? [{ key: 'prep' }] : []),
    ...(content.sourceListCount > 0 ? [{ key: 'lists' }] : []),
    /**
     * INGREDIENTS (P3-43): a Meal whose stored details carry ingredient rows renders the
     * picker — selection checkboxes, the resolved destination, `Add n to <list>`. A Meal
     * with no rows has nothing to add and shows no section; the rows are edited on the form.
     */
    ...(activity.type === 'meal' &&
    activity.details.kind === 'meal' &&
    (activity.details.ingredients?.length ?? 0) > 0
      ? [{ key: 'ingredients' as const }]
      : []),
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
    // §2.2's one owner of the rule: hidden while private with no entries (P3-40).
    ...(updatesSectionVisible(activity.visibility, content.updateCount)
      ? [{ key: 'updates' }]
      : []),
  ];
}

/**
 * The header's second line: `Event · Just you`, `Task`.
 *
 * Phase 1 has no participants, so the share state is always "just you" on a Plan and is
 * omitted entirely on a Task — a Task has no sharing state to describe, not even a solo one
 * (`today-and-tasks.md` §5.1).
 */
export function subtitleFor(activity: DisplayActivity, planKindLabel: string): string {
  if (activity.objectKind === 'task') return 'Task';
  return `${planKindLabel} · Just you`;
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
