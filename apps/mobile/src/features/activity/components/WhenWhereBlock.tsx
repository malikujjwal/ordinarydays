import type { Reminder } from '@od/shared/types';
import { Card, Text, Touchable, useTheme } from '@od/ui';
import { View } from 'react-native';
import {
  formatReminderOffset,
  formatSchedule,
  type WallDate,
} from '@/features/activity/model/dates';

/**
 * The when / where block (`plans-and-lists.md` §2.1 row 2).
 *
 * Three rows in one card: the schedule, the location, and **your own** reminders.
 *
 * ## The date row is a button, and the address row is a different button
 *
 * §2.1 is explicit that they are separate tap targets — the first opens the reschedule sheet
 * (U4), the second opens the platform maps app. Wrapping the whole card in one `Pressable`
 * would be the easy thing and would make the address unreachable, so the card is not
 * pressable and each row carries its own target with `space[3]` between them.
 *
 * **Never inline-editable.** Tapping the date opens the sheet; it does not turn into a field.
 * That is U4 and it holds everywhere a date is rendered in the product.
 *
 * ## The reminders are the caller's, and the screen says nothing about anyone else's
 *
 * A shared plan has one schedule and many reminder sets (ADR-047). This renders the rows the
 * server gave it, which are already filtered to the caller — no count, no avatars, and no
 * hint that anybody else has one. The row is hidden entirely when the plan has no date,
 * because there is nothing to count back from (§2.2).
 */
export interface WhenWhereBlockProps {
  schedule: { date: string; time?: string; endTime?: string } | undefined;
  location: { label: string; address?: string } | undefined;
  reminders: Reminder[];
  today: WallDate;
  onPressDate: () => void;
  onPressAddress: (() => void) | undefined;
}

export function WhenWhereBlock({
  schedule,
  location,
  reminders,
  today,
  onPressDate,
  onPressAddress,
}: WhenWhereBlockProps) {
  const theme = useTheme();
  const scheduled = schedule !== undefined;

  return (
    <Card testID="when-where">
      <View style={{ gap: theme.space[3] }}>
        <Touchable
          square={false}
          accessibilityRole="button"
          accessibilityLabel={`${formatSchedule(schedule, today)}, change the date`}
          onPress={onPressDate}
          testID="when-where-date"
        >
          <Text variant="bodyStrong" color={scheduled ? 'textPrimary' : 'textSecondary'}>
            {formatSchedule(schedule, today)}
          </Text>
        </Touchable>

        {location === undefined || location.label === '' ? null : (
          <Touchable
            square={false}
            accessibilityRole="button"
            accessibilityLabel={
              location.address === undefined
                ? location.label
                : `${location.label}, ${location.address}, open in Maps`
            }
            disabled={onPressAddress === undefined}
            onPress={onPressAddress}
            testID="when-where-location"
          >
            <Text variant="body" color="textSecondary">
              {location.label}
            </Text>
            {location.address === undefined ? null : (
              <Text variant="footnote" color="textSecondary">
                {location.address}
              </Text>
            )}
          </Touchable>
        )}

        {/* Hidden without a date: nothing to count back from (§2.2). */}
        {!scheduled ? null : (
          <View style={{ gap: theme.space[2] }} testID="when-where-reminders">
            {reminders.length === 0 ? (
              <Text variant="footnote" color="textSecondary">
                No reminder
              </Text>
            ) : (
              reminders.map((reminder) => (
                <Text key={reminder.reminderId} variant="footnote" color="textSecondary">
                  {`Remind me · ${formatReminderOffset(reminder.offsetMinutes)}`}
                </Text>
              ))
            )}
          </View>
        )}
      </View>
    </Card>
  );
}
