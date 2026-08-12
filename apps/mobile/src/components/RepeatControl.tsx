import { describeRecurrence } from '@od/shared/recurrence';
import type { Recurrence } from '@od/shared/types';
import { Button, Text, useTheme } from '@od/ui';
import { useState } from 'react';
import { View } from 'react-native';
import { RepeatSheet } from '@/features/activity/components/RepeatSheet';

export interface RepeatControlProps {
  date: string | undefined;
  value: Recurrence | undefined;
  today: string;
  onChange: (value: Recurrence | undefined) => void;
}

/** App-level connector: compose owns the draft; activity owns the domain sheet. */
export function RepeatControl({ date, value, today, onChange }: RepeatControlProps) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const summary = value === undefined ? 'Never' : describeRecurrence(value, today);

  return (
    <View style={{ gap: theme.space[2] }}>
      <Text variant="footnoteStrong" color="textSecondary">
        Repeat
      </Text>
      <Button
        label={summary}
        accessibilityLabel={`Repeat: ${summary}`}
        variant="secondary"
        fullWidth
        disabled={date === undefined}
        onPress={() => setOpen(true)}
        testID="compose-repeat"
      />
      {date === undefined ? (
        <Text variant="footnote" color="textSecondary">
          Add a date to repeat this.
        </Text>
      ) : (
        <RepeatSheet
          open={open}
          onClose={() => setOpen(false)}
          anchorDate={date}
          {...(value === undefined ? {} : { value })}
          onCommit={async (next) => {
            onChange(next);
            return true;
          }}
        />
      )}
    </View>
  );
}
