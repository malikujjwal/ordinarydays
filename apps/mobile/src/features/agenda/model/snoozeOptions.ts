export type SnoozeOption =
  | { key: 'minutes15' | 'hour1' | 'hours3' | 'evening'; label: string; until: string }
  | { key: 'tomorrow'; label: 'Tomorrow' }
  | { key: 'pick'; label: 'Pick a time' };

/** `HH:mm` as minutes since midnight. Exported so a caller can compare against the base. */
export const minuteOfDay = (value: string): number => {
  const [hours = '0', minutes = '0'] = value.split(':');
  return Number(hours) * 60 + Number(minutes);
};

const wallTime = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/**
 * The exact P2-25 option table, computed from the point the occurrence is being moved **from**.
 *
 * ## The base is the later of now and the occurrence's own time
 *
 * `today-and-tasks.md` §5.3 opens with "Snooze moves *this occurrence* later", and prunes
 * options that "would land in the past". Those two are the same sentence only once an item is
 * due. Computed from the clock alone, snoozing a 6:00 PM task at 2:10 PM offered `15 minutes` →
 * 2:25 PM, which moves it two and a half hours **earlier** — a snooze that brings a task
 * forward, reported from the built sheet.
 *
 * Anchoring on `max(now, itemTime)` keeps the clock as the base for anything already due, which
 * is the case the pruning rule was written for, and makes every option a move later for
 * anything that is not. Fixed options are dropped when they do not clear the base, so
 * `This evening (6 PM)` disappears on a 6:00 PM task rather than offering to move it nowhere.
 */
export function snoozeOptions(
  currentMinute: string,
  recurring: boolean,
  /** The occurrence's effective time. Absent keeps the old clock-only base. */
  itemTime?: string,
): SnoozeOption[] {
  const now = minuteOfDay(currentMinute);
  const base = itemTime === undefined ? now : Math.max(now, minuteOfDay(itemTime));
  const options: SnoozeOption[] = [];
  const relative = [
    { key: 'minutes15' as const, label: '15 minutes', offset: 15 },
    { key: 'hour1' as const, label: '1 hour', offset: 60 },
    { key: 'hours3' as const, label: '3 hours', offset: 180 },
  ];

  for (const option of relative) {
    const destination = base + option.offset;
    if (destination < 24 * 60) {
      options.push({
        key: option.key,
        label: option.label,
        until: wallTime(destination),
      });
    }
  }
  if (base < 18 * 60) {
    options.push({ key: 'evening', label: 'This evening (6 PM)', until: '18:00' });
  }
  if (!recurring) options.push({ key: 'tomorrow', label: 'Tomorrow' });
  options.push({ key: 'pick', label: 'Pick a time' });
  return options;
}

/**
 * A picked time has to clear the same base the fixed options do, so `Pick a time` cannot do
 * what the buttons beside it are prevented from doing.
 */
export const isFutureWallTime = (
  value: string,
  currentMinute: string,
  itemTime?: string,
): boolean => {
  const base =
    itemTime === undefined
      ? minuteOfDay(currentMinute)
      : Math.max(minuteOfDay(currentMinute), minuteOfDay(itemTime));
  return minuteOfDay(value) > base;
};
