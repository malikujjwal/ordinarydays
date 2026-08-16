import { describeRecurrence } from '@od/shared/recurrence';
import type { Recurrence } from '@od/shared/types';
import { SettingRow } from '@od/ui';
import { useState } from 'react';
import { View } from 'react-native';
import { RepeatSheet } from '@/features/activity/components/RepeatSheet';

export interface RepeatControlProps {
  /** The day the rule is anchored to. The caller renders nothing without one (P2-43). */
  date: string;
  value: Recurrence | undefined;
  today: string;
  onChange: (value: Recurrence | undefined) => void;
}

/**
 * App-level connector: compose owns the draft; activity owns the domain sheet.
 *
 * `date` is required rather than optional, which is P2-43's disabled-state removal made
 * structural — there is no longer a way to render this control without a day for the rule to
 * hang off, so `Add a date to repeat this.` has nowhere to be said.
 *
 * A `SettingRow` rather than a full-width secondary button, so Repeat reads the same here as it
 * does on the activity detail screen: label left, current state right, sheet on tap.
 */
export function RepeatControl({ date, value, today, onChange }: RepeatControlProps) {
  const [open, setOpen] = useState(false);
  const summary =
    value === undefined ? 'Does not repeat' : describeRecurrence(value, today);

  return (
    <View>
      <SettingRow
        label="Repeat"
        value={summary}
        opens
        onPress={() => setOpen(true)}
        testID="compose-repeat"
      />
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
    </View>
  );
}
