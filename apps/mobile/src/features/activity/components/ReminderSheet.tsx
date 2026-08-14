import type { Reminder } from '@od/shared/types';
import { SettingRow, Sheet, Text } from '@od/ui';
import { View } from 'react-native';
import { formatReminderOffset } from '@/features/activity/model/dates';

const TIMED_OFFSETS = [0, -5, -15, -30, -60, -120, -1440, -2880] as const;
const ALL_DAY_OFFSETS = [0, -1440, -2880] as const;

export function reminderOptionLabel(offsetMinutes: number, timed: boolean): string {
  if (!timed && offsetMinutes === 0) return 'On the day';
  return formatReminderOffset(offsetMinutes);
}

/** The row's right-hand value: the caller's own reminder set, summarised. */
export function reminderSummary(reminders: Reminder[], timed: boolean): string {
  if (reminders.length === 0) return 'None';
  if (reminders.length === 1) {
    return reminderOptionLabel(reminders[0]?.offsetMinutes ?? 0, timed);
  }
  return `${reminders.length} reminders`;
}

export interface ReminderSheetProps {
  open: boolean;
  onClose: () => void;
  reminders: Reminder[];
  timed: boolean;
  busy: boolean;
  error?: string;
  onAdd: (offsetMinutes: number) => Promise<boolean>;
  onRemove: (reminderId: string) => Promise<boolean>;
}

/**
 * Reminder choices, in the sheet the founder's frames draw them in.
 *
 * They were built as an inline disclosure that pushed every row below it down the screen when
 * opened. The frames show this choice as a dropdown over the screen — the same treatment
 * `Repeat` gets — and the founder confirmed it on 2026-08-13: "Reminder was meant to be a
 * dropdown, not an inline one." Sharing `Sheet` also means it inherits the focus trap, the
 * scrim dismiss and the `medium`-and-up centred-dialog form for free.
 *
 * The set shown is the caller's alone; the detail response filtered it server-side, and a
 * shared plan's other reminder sets are neither counted nor hinted at (ADR-047).
 */
export function ReminderSheet({
  open,
  onClose,
  reminders,
  timed,
  busy,
  error,
  onAdd,
  onRemove,
}: ReminderSheetProps) {
  const reminderByOffset = new Map(
    reminders.map((reminder) => [reminder.offsetMinutes, reminder]),
  );
  const options = timed ? TIMED_OFFSETS : ALL_DAY_OFFSETS;
  const atLimit = reminders.length >= 3;

  // A choice list — `medium`, scrolling internally, per §6.1's detent table.
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Reminder"
      detent="medium"
      testID="reminder-sheet"
    >
      <View testID="reminder-menu">
        {options.map((offsetMinutes) => {
          const existing = reminderByOffset.get(offsetMinutes);
          const selected = existing !== undefined;
          const label = reminderOptionLabel(offsetMinutes, timed);
          return (
            <SettingRow
              key={offsetMinutes}
              label={label}
              role="checkbox"
              selected={selected}
              disabled={busy || (atLimit && !selected)}
              accessibilityLabel={`${selected ? 'Remove' : 'Add'} reminder ${label}`}
              onPress={() => {
                if (existing === undefined) void onAdd(offsetMinutes);
                else void onRemove(existing.reminderId);
              }}
              testID={`reminder-option-${offsetMinutes}`}
            />
          );
        })}
      </View>

      {atLimit ? (
        <Text variant="footnote" color="textMuted">
          You can add up to 3 reminders.
        </Text>
      ) : null}

      {error === undefined ? null : (
        <Text accessibilityRole="alert" variant="footnote" color="danger">
          {error}
        </Text>
      )}
    </Sheet>
  );
}
