import type { Activity } from '@od/shared/types';

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

const COMING_LATER: DetailSection[] = [
  {
    key: 'people',
    label: 'People',
    summary: 'Sharing and participants',
    state: 'coming-later',
  },
  {
    key: 'prep',
    label: 'Preparation',
    summary: 'Tasks that help make this happen',
    state: 'coming-later',
  },
  {
    key: 'lists',
    label: 'Related lists',
    summary: 'Lists connected to this plan',
    state: 'coming-later',
  },
];

/**
 * The sections for one activity, in render order.
 *
 * Notes-first order is the founder's 2026-08-13 refinement to the canonical detail anatomy.
 * The remaining Plan capabilities keep `plans-and-lists.md` §2.1's relative order.
 */
export function sectionsFor(activity: Activity): DetailSection[] {
  if (activity.objectKind === 'task') {
    // §5.6's list, and nothing else. No placeholders.
    return [
      { key: 'whenWhere' },
      { key: 'notes', label: 'Notes' },
      ...(activity.schedule === undefined ? [] : [{ key: 'reminders' }]),
      { key: 'relatedPlan', label: 'Related plan' },
    ];
  }

  return [
    { key: 'whenWhere' },
    { key: 'notes', label: 'Notes' },
    ...(activity.schedule === undefined ? [] : [{ key: 'reminders' }]),
    ...COMING_LATER,
    ...(activity.type === 'meal'
      ? [
          {
            key: 'ingredients',
            label: 'Ingredients',
            summary: 'Meal ingredients and shopping',
            state: 'coming-later' as const,
          },
        ]
      : []),
    {
      key: 'attachments',
      label: 'Attachments',
      summary: 'Photos and files',
      state: 'coming-later',
    },
  ];
}

/**
 * The header's second line: `Event · Just you`, `Task`.
 *
 * Phase 1 has no participants, so the share state is always "just you" on a Plan and is
 * omitted entirely on a Task — a Task has no sharing state to describe, not even a solo one
 * (`today-and-tasks.md` §5.1).
 */
export function subtitleFor(activity: Activity, planKindLabel: string): string {
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
