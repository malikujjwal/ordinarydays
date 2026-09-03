import { differenceInWallDays } from '@od/shared/recurrence';
import { format, parseISO } from 'date-fns';

/**
 * The compact original-date label used by rolled-forward overdue tasks.
 * `today` is injected so the result is deterministic in every timezone and test.
 */
export function formatOverdueChip(overdueFromDate: string, today: string): string {
  const daysAgo = differenceInWallDays(today, overdueFromDate);
  if (daysAgo === 1) return 'Yesterday';

  const date = parseISO(overdueFromDate);
  if (daysAgo >= 2 && daysAgo <= 6) return format(date, 'EEE');
  return format(date, 'd MMM');
}

/** Compact age used at the trailing edge of Today's untimed overdue rows. */
export function formatOverdueAge(overdueFromDate: string, today: string): string {
  const days = Math.max(1, differenceInWallDays(today, overdueFromDate));
  return `${days} ${days === 1 ? 'day' : 'days'}`;
}

/** The original due date shown beneath an overdue task title. */
export function formatOverdueDueDate(overdueFromDate: string): string {
  return `Due ${format(parseISO(overdueFromDate), 'MMM d')}`;
}

/** The unabbreviated date spoken for an overdue chip. */
export function formatOverdueAccessibilityLabel(overdueFromDate: string): string {
  return `Overdue from ${format(parseISO(overdueFromDate), 'EEEE d MMMM')}`;
}
