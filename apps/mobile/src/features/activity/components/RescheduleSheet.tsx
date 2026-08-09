import { Button, Chip, Field, Sheet, Text, useTheme } from '@od/ui';
import { useState } from 'react';
import { View } from 'react-native';
import {
  type QuickDate,
  quickDates,
  type WallDate,
} from '@/features/activity/model/dates';

/**
 * The reschedule sheet (U4, `activities.md` §6.2).
 *
 * > Tapping the date or time **anywhere in the product** opens this. It never edits in place
 * > on the row.
 *
 * That is a universal rule rather than a screen's preference, which is why this component
 * takes a value and a callback and knows nothing about activities: Today's rows, the plan
 * detail's when/where block and a list item's state line all open the same sheet.
 *
 * ## What it does not do yet
 *
 * `Clear the date` on an activity with participants owes the §1a.1 confirmation naming what
 * comes off everyone's day. Phase 1 has no participants, so the branch is unreachable and is
 * deliberately not written — a confirmation nobody can trigger is a confirmation nobody has
 * tested. P6 adds it with the first participant.
 *
 * A recurring series owes the `This occurrence only` / `All future occurrences` choice
 * (§6.2). Recurrence is Phase 2 (P2-01); the same applies.
 */
export interface RescheduleSheetProps {
  open: boolean;
  onClose: () => void;
  /** The user's today, in their zone. Injected so the chips are testable (§4.3). */
  today: WallDate;
  /** The activity's current date, or `undefined` when it has none. */
  value: WallDate | undefined;
  onChoose: (date: WallDate) => void;
  onClear: () => void;
}

export function RescheduleSheet({
  open,
  onClose,
  today,
  value,
  onChoose,
  onClear,
}: RescheduleSheetProps) {
  const theme = useTheme();
  const [picking, setPicking] = useState(false);
  const [typed, setTyped] = useState(value ?? '');

  const choose = (chip: QuickDate) => {
    if (chip.date === undefined) {
      setPicking(true);
      return;
    }
    onChoose(chip.date);
    onClose();
  };

  const commitTyped = () => {
    // The one validation the sheet owns: a date it cannot parse is not sent to the server
    // to be rejected. Everything else about the value is the schema's business.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(typed)) return;
    onChoose(typed);
    setPicking(false);
    onClose();
  };

  return (
    <Sheet open={open} onClose={onClose} title="When?" testID="reschedule-sheet">
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[3] }}>
        {quickDates(today).map((chip) => (
          <Chip
            key={chip.key}
            label={chip.label}
            onPress={() => choose(chip)}
            selected={chip.date !== undefined && chip.date === value}
            testID={`quick-date-${chip.key}`}
          />
        ))}
      </View>

      {picking ? (
        <View style={{ gap: theme.space[3] }}>
          <Field
            label="Date"
            value={typed}
            onChangeText={setTyped}
            placeholder="YYYY-MM-DD"
            hint="v1 has no calendar grid — type the date."
            testID="reschedule-date-input"
          />
          <Button label="Set date" onPress={commitTyped} testID="reschedule-commit" />
        </View>
      ) : null}

      {value === undefined ? null : (
        <View>
          <Button
            label="Clear the date"
            variant="ghost"
            onPress={() => {
              onClear();
              onClose();
            }}
            testID="reschedule-clear"
          />
          <Text variant="footnote" color="textSecondary">
            It stays a plan. It moves back to Needs a date.
          </Text>
        </View>
      )}
    </Sheet>
  );
}
