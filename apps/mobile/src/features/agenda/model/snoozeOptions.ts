export type SnoozeOption =
  | { key: 'minutes15' | 'hour1' | 'hours3' | 'evening'; label: string; until: string }
  | { key: 'tomorrow'; label: 'Tomorrow' }
  | { key: 'pick'; label: 'Pick a time' };

const minuteOfDay = (value: string): number => {
  const [hours = '0', minutes = '0'] = value.split(':');
  return Number(hours) * 60 + Number(minutes);
};

const wallTime = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/** The exact P2-25 option table, with same-day values that are already past removed. */
export function snoozeOptions(currentMinute: string, recurring: boolean): SnoozeOption[] {
  const now = minuteOfDay(currentMinute);
  const options: SnoozeOption[] = [];
  const relative = [
    { key: 'minutes15' as const, label: '15 minutes', offset: 15 },
    { key: 'hour1' as const, label: '1 hour', offset: 60 },
    { key: 'hours3' as const, label: '3 hours', offset: 180 },
  ];

  for (const option of relative) {
    const destination = now + option.offset;
    if (destination < 24 * 60) {
      options.push({
        key: option.key,
        label: option.label,
        until: wallTime(destination),
      });
    }
  }
  if (now < 18 * 60) {
    options.push({ key: 'evening', label: 'This evening (6 PM)', until: '18:00' });
  }
  if (!recurring) options.push({ key: 'tomorrow', label: 'Tomorrow' });
  options.push({ key: 'pick', label: 'Pick a time' });
  return options;
}

export const isFutureWallTime = (value: string, currentMinute: string): boolean =>
  minuteOfDay(value) > minuteOfDay(currentMinute);
