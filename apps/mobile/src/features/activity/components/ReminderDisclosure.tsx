import type { Reminder } from '@od/shared/types';
import { Button, Chip, Text, useTheme } from '@od/ui';
import { View } from 'react-native';
import { formatReminderOffset } from '@/features/activity/model/dates';
import { DetailDisclosureRow } from './DetailDisclosureRow';

const TIMED_OFFSETS = [0, -5, -15, -30, -60, -120, -1440, -2880] as const;
const ALL_DAY_OFFSETS = [0, -1440, -2880] as const;

function reminderLabel(offsetMinutes: number, timed: boolean): string {
  if (!timed && offsetMinutes === 0) return 'On the day';
  return formatReminderOffset(offsetMinutes);
}

export interface ReminderDisclosureProps {
  reminders: Reminder[];
  timed: boolean;
  busy: boolean;
  error?: string;
  onAdd: (offsetMinutes: number) => Promise<boolean>;
  onRemove: (reminderId: string) => Promise<boolean>;
}

/** The caller's reminder set only; the detail response has already filtered it server-side. */
export function ReminderDisclosure({
  reminders,
  timed,
  busy,
  error,
  onAdd,
  onRemove,
}: ReminderDisclosureProps) {
  const theme = useTheme();
  const selected = new Set(reminders.map((reminder) => reminder.offsetMinutes));
  const options = (timed ? TIMED_OFFSETS : ALL_DAY_OFFSETS).filter(
    (offset) => !selected.has(offset),
  );
  const summary =
    reminders.length === 0
      ? 'No reminder'
      : reminders.length === 1
        ? reminderLabel(reminders[0]?.offsetMinutes ?? 0, timed)
        : `${reminders.length} reminders`;
  const atLimit = reminders.length >= 3;

  return (
    <DetailDisclosureRow title="Reminder" summary={summary} testID="section-reminders">
      {reminders.map((reminder) => {
        const label = reminderLabel(reminder.offsetMinutes, timed);
        return (
          <View
            key={reminder.reminderId}
            style={{
              minHeight: theme.layout.hitTarget,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: theme.space[4],
            }}
          >
            <Text variant="body" color="textPrimary">
              {label}
            </Text>
            <Button
              label="Remove"
              accessibilityLabel={`Remove reminder ${label}`}
              variant="ghost"
              disabled={busy}
              onPress={() => void onRemove(reminder.reminderId)}
            />
          </View>
        );
      })}

      {atLimit ? (
        <Text variant="footnote" color="textSecondary">
          You can add up to 3 reminders.
        </Text>
      ) : (
        <View style={{ gap: theme.space[3] }}>
          <Text variant="footnoteStrong" color="textSecondary">
            Add a reminder
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[3] }}>
            {options.map((offsetMinutes) => {
              const label = reminderLabel(offsetMinutes, timed);
              return (
                <Chip
                  key={offsetMinutes}
                  label={label}
                  accessibilityLabel={`Add reminder ${label}`}
                  disabled={busy}
                  onPress={() => void onAdd(offsetMinutes)}
                  testID={`reminder-option-${offsetMinutes}`}
                />
              );
            })}
          </View>
        </View>
      )}

      {error === undefined ? null : (
        <Text accessibilityRole="alert" variant="footnote" color="danger">
          {error}
        </Text>
      )}
    </DetailDisclosureRow>
  );
}
