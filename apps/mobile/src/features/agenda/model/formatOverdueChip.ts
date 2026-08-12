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

/** The unabbreviated date spoken for an overdue chip. */
export function formatOverdueAccessibilityLabel(overdueFromDate: string): string {
  return `Overdue from ${format(parseISO(overdueFromDate), 'EEEE d MMMM')}`;
}
