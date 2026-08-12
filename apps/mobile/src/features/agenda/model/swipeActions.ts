import type { AgendaItem } from '@od/shared/types';

export type AgendaSwipeActionName =
  | 'complete'
  | 'delete'
  | 'doToday'
  | 'editSeries'
  | 'openPlan'
  | 'reschedule'
  | 'schedule'
  | 'skip'
  | 'snooze'
  | 'undo'
  | 'undoSkip';

export interface AgendaSwipeAction {
  name: AgendaSwipeActionName;
  label: string;
  destructive: boolean;
  /** Set only for Open plan; never an authorisation input. */
  targetActivityId?: string;
}

export interface AgendaSwipeActions {
  positive: AgendaSwipeAction[];
  secondary: AgendaSwipeAction[];
}

const action = (
  name: AgendaSwipeActionName,
  label: string,
  destructive = false,
): AgendaSwipeAction => ({ name, label, destructive });

const DELETE = action('delete', 'Delete', true);
const RESCHEDULE = action('reschedule', 'Reschedule');

const positiveVerb = (item: AgendaItem): string => {
  switch (item.type) {
    case 'task':
      return 'Complete';
    case 'meal':
      return 'Had it';
    case 'watch':
      return 'Watched';
    case 'event':
      return 'Attended';
    case 'custom':
      return 'Done';
  }
};

const isCompleted = (item: AgendaItem): boolean =>
  item.status === 'completed' || item.status === 'completed_occurrence';

const isSkipped = (item: AgendaItem): boolean =>
  item.status === 'skipped' || item.status === 'skipped_occurrence';

/**
 * The interaction-contract gesture table, intersected with server-authored capabilities.
 * Parent presence selects the prep-task row and supplies only Open plan's target.
 */
export function agendaSwipeActions(item: AgendaItem): AgendaSwipeActions {
  if (isCompleted(item)) {
    return {
      positive: item.capabilities.complete ? [action('undo', 'Undo')] : [],
      secondary: [DELETE],
    };
  }

  if (isSkipped(item)) {
    return {
      positive: item.capabilities.complete ? [action('undoSkip', 'Undo skip')] : [],
      secondary: [DELETE],
    };
  }

  const positive = item.capabilities.complete
    ? [action('complete', positiveVerb(item))]
    : [];

  if (item.parentActivityId !== undefined) {
    return {
      positive,
      secondary: [
        {
          ...action('openPlan', 'Open plan'),
          targetActivityId: item.parentActivityId,
        },
        RESCHEDULE,
        DELETE,
      ],
    };
  }

  if (item.type !== 'task') {
    return { positive, secondary: [RESCHEDULE, DELETE] };
  }

  if (item.isRecurring) {
    return {
      positive,
      secondary: [
        ...(item.capabilities.snooze ? [action('snooze', 'Snooze')] : []),
        ...(item.capabilities.skip ? [action('skip', 'Skip')] : []),
        action('editSeries', 'Edit series'),
      ],
    };
  }

  if (item.overdueFromDate !== undefined) {
    return {
      positive,
      secondary: [action('doToday', 'Do today'), RESCHEDULE, DELETE],
    };
  }

  if (item.time !== undefined) {
    return {
      positive,
      secondary: [
        ...(item.capabilities.snooze ? [action('snooze', 'Snooze')] : []),
        RESCHEDULE,
        DELETE,
      ],
    };
  }

  return { positive, secondary: [action('schedule', 'Schedule'), DELETE] };
}

export function allAgendaSwipeActions(actions: AgendaSwipeActions): AgendaSwipeAction[] {
  return [...actions.positive, ...actions.secondary];
}

export function agendaAccessibilityActions(
  actions: AgendaSwipeActions,
): { name: string; label: string }[] {
  return allAgendaSwipeActions(actions).map(({ name, label }) => ({ name, label }));
}
