import type { AgendaItem } from '@od/shared/types';
import { Chip, formatWallTime, Sheet, Text, TimePicker, useTheme } from '@od/ui';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { isFutureWallTime, snoozeOptions } from '@/features/agenda/model/snoozeOptions';

export interface SnoozeSheetProps {
  open: boolean;
  item: AgendaItem | undefined;
  currentMinute: string;
  onClose: () => void;
  onSnooze: (item: AgendaItem, until: string) => void;
  onTomorrow: (item: AgendaItem) => void;
}

/**
 * The context-sensitive snooze choices for a timed Task or recurring occurrence.
 *
 * ## It says what it is moving, and how far the move reaches (P2-42)
 *
 * The sheet used to open on six unlabelled buttons. Swiped from a row it was clear enough;
 * reached from anywhere else it asked the user to move something it had not named, and on a
 * recurring occurrence it never said that tomorrow's instance keeps the series time — the one
 * fact that decides whether snoozing is the right action at all (`today-and-tasks.md` §5.3).
 *
 * **P2-25's option table is unchanged.** The six options, the pruning of anything already past,
 * and the deliberate absence of `Tomorrow` on a recurring occurrence are that task's and are
 * canonical; this changed only how they are arranged and what sits above them.
 */
export function SnoozeSheet({
  open,
  item,
  currentMinute,
  onClose,
  onSnooze,
  onTomorrow,
}: SnoozeSheetProps) {
  const theme = useTheme();
  const [pickedTime, setPickedTime] = useState<string | null>(null);
  const [pickError, setPickError] = useState<string>();

  useEffect(() => {
    if (open) {
      setPickedTime(null);
      setPickError(undefined);
    }
  }, [open]);

  if (
    item === undefined ||
    !item.capabilities.snooze ||
    item.type !== 'task' ||
    item.time === undefined
  ) {
    return null;
  }
  const itemTime = item.time;

  /**
   * The time the row would have kept. On an already-snoozed row `time` is the snoozed value and
   * `originalTime` is the schedule's, so the blast radius names the series time rather than
   * whatever the last snooze happened to land on.
   */
  const scheduledTime = item.originalTime ?? itemTime;

  /**
   * **The blast radius, above the options rather than discovered after them.** A snooze writes
   * an `Occurrence` override and never touches the series (`data-model.md` §4.5), which is
   * exactly the thing a user cannot see from a list of times.
   */
  const blastRadius = item.isRecurring
    ? `Today only. Tomorrow stays ${formatWallTime(scheduledTime)}.`
    : 'Today only. Nothing else changes.';

  const chooseTime = (until: string) => {
    onSnooze(item, until);
    onClose();
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Snooze"
      detent="fit"
      testID="snooze-sheet"
    >
      <View style={{ gap: theme.space[5] }}>
        <View style={{ gap: theme.space[1] }}>
          <Text variant="subhead" color="textPrimary" testID="snooze-subject">
            {`${item.title} · ${formatWallTime(itemTime)}`}
          </Text>
          <Text variant="footnote" color="textSecondary" testID="snooze-blast-radius">
            {blastRadius}
          </Text>
        </View>

        {/**
         * A wrapped grid rather than a column of full-width buttons: these are five short,
         * equal, non-destructive choices, and stacking them made the sheet as tall as the
         * screen for a decision worth one glance. `Chip` is already the product's pill and
         * already carries `Touchable`'s 44 pt floor, so the target does not shrink with the ink.
         */}
        <View
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            gap: theme.space[3],
          }}
        >
          {snoozeOptions(currentMinute, item.isRecurring).map((option) => {
            if (option.key === 'pick') return null;
            if (option.key === 'tomorrow') {
              return (
                <Chip
                  key={option.key}
                  label={option.label}
                  accessibilityLabel={`Move to tomorrow at ${formatWallTime(itemTime)}`}
                  onPress={() => {
                    onTomorrow(item);
                    onClose();
                  }}
                  testID="snooze-tomorrow"
                />
              );
            }
            return (
              <Chip
                key={option.key}
                label={option.label}
                accessibilityLabel={`Snooze until ${formatWallTime(option.until)}`}
                onPress={() => chooseTime(option.until)}
                testID={`snooze-${option.key}`}
              />
            );
          })}
        </View>

        {/**
         * `Pick a time` keeps its own labelled block beneath the grid: it opens a wheel rather
         * than committing a value, and a pill that sometimes reveals a picker inside the row it
         * sits in is the affordance ambiguity §0 rules against.
         */}
        <View style={{ gap: theme.space[2] }}>
          <TimePicker
            label="Snooze time"
            triggerLabel="Pick a time"
            value={pickedTime}
            onChange={(value) => {
              setPickedTime(value);
              setPickError(undefined);
            }}
            onConfirm={(value) => {
              if (!isFutureWallTime(value, currentMinute)) {
                setPickError('Choose a time later than now.');
                return;
              }
              chooseTime(value);
            }}
            openAt={currentMinute}
            minuteInterval={5}
            allowClear={false}
            presentation="inline"
            testID="snooze-time-picker"
          />
          {pickError === undefined ? null : (
            <Text color="danger" accessibilityRole="alert" testID="snooze-time-error">
              {pickError}
            </Text>
          )}
        </View>
      </View>
    </Sheet>
  );
}
