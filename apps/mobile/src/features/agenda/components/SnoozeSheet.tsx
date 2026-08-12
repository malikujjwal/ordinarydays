import type { AgendaItem } from '@od/shared/types';
import { Button, formatWallTime, Sheet, Text, TimePicker, useTheme } from '@od/ui';
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

/** The context-sensitive snooze choices for a timed Task or recurring occurrence. */
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

  const chooseTime = (until: string) => {
    onSnooze(item, until);
    onClose();
  };

  return (
    <Sheet open={open} onClose={onClose} title="Snooze" testID="snooze-sheet">
      <View style={{ gap: theme.space[3] }}>
        {snoozeOptions(currentMinute, item.isRecurring).map((option) => {
          if (option.key === 'pick') {
            return (
              <View key={option.key} style={{ gap: theme.space[2] }}>
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
                  testID="snooze-time-picker"
                />
                {pickError === undefined ? null : (
                  <Text
                    color="danger"
                    accessibilityRole="alert"
                    testID="snooze-time-error"
                  >
                    {pickError}
                  </Text>
                )}
              </View>
            );
          }
          if (option.key === 'tomorrow') {
            return (
              <Button
                key={option.key}
                label={option.label}
                accessibilityLabel={`Move to tomorrow at ${formatWallTime(itemTime)}`}
                variant="secondary"
                fullWidth
                onPress={() => {
                  onTomorrow(item);
                  onClose();
                }}
                testID="snooze-tomorrow"
              />
            );
          }
          return (
            <Button
              key={option.key}
              label={option.label}
              accessibilityLabel={`Snooze until ${formatWallTime(option.until)}`}
              variant="secondary"
              fullWidth
              onPress={() => chooseTime(option.until)}
              testID={`snooze-${option.key}`}
            />
          );
        })}
      </View>
    </Sheet>
  );
}
