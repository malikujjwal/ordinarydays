import type { Reminder } from '@od/shared/types';
import { Check, Text, Touchable, useTheme } from '@od/ui';
import { ScrollView, View } from 'react-native';
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
  const reminderByOffset = new Map(
    reminders.map((reminder) => [reminder.offsetMinutes, reminder]),
  );
  const options = timed ? TIMED_OFFSETS : ALL_DAY_OFFSETS;
  const summary =
    reminders.length === 0
      ? 'No reminder'
      : reminders.length === 1
        ? reminderLabel(reminders[0]?.offsetMinutes ?? 0, timed)
        : `${reminders.length} reminders`;
  const atLimit = reminders.length >= 3;

  return (
    <DetailDisclosureRow title="Reminder" summary={summary} testID="section-reminders">
      <ScrollView
        style={{ maxHeight: theme.layout.rowMinHeight * 4 }}
        nestedScrollEnabled
        showsVerticalScrollIndicator
        testID="reminder-menu"
      >
        {options.map((offsetMinutes) => {
          const existing = reminderByOffset.get(offsetMinutes);
          const selected = existing !== undefined;
          const label = reminderLabel(offsetMinutes, timed);
          const disabled = busy || (atLimit && !selected);
          return (
            <Touchable
              key={offsetMinutes}
              square={false}
              accessibilityRole="checkbox"
              accessibilityLabel={`${selected ? 'Remove' : 'Add'} reminder ${label}`}
              accessibilityState={{ checked: selected, disabled }}
              disabled={disabled}
              onPress={() => {
                if (existing === undefined) void onAdd(offsetMinutes);
                else void onRemove(existing.reminderId);
              }}
              testID={`reminder-option-${offsetMinutes}`}
            >
              <View
                style={{
                  minHeight: theme.layout.rowMinHeight,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: theme.space[4],
                  borderBottomWidth: 1,
                  borderBottomColor: theme.colors.border,
                }}
              >
                <View style={{ flex: 1 }}>
                  <Text variant="body" color="textPrimary">
                    {label}
                  </Text>
                </View>
                {selected ? (
                  <Check size={20} color={theme.colors.success} />
                ) : (
                  <Text variant="footnoteStrong" color="textAction">
                    Add
                  </Text>
                )}
              </View>
            </Touchable>
          );
        })}
      </ScrollView>

      {atLimit ? (
        <Text variant="footnote" color="textSecondary">
          You can add up to 3 reminders.
        </Text>
      ) : null}

      {error === undefined ? null : (
        <Text accessibilityRole="alert" variant="footnote" color="danger">
          {error}
        </Text>
      )}
    </DetailDisclosureRow>
  );
}
