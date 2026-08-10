import { useState } from 'react';
import { View } from 'react-native';
import { Close } from '../icons/index';
import { useTheme } from '../theme/index';
import { Button } from './Button';
import { Chip } from './Chip';
import { IconButton } from './IconButton';
import { DateSurface } from './pickerSurface';
import { Sheet } from './Sheet';
import { Text } from './Text';
import {
  DATE_QUICK_LABELS,
  DATE_QUICK_OPTIONS,
  type DateQuickOption,
  formatWallDate,
  isWallDateInRange,
  resolveQuickDate,
  type WallDate,
} from './wallClock';

/**
 * A date, chosen from quick chips or from the platform calendar (`design-system.md` §6).
 *
 * The chips and their copy are `activities.md` §3.4's, in its order: `Today`, `Tomorrow`,
 * `This weekend`, `Next week`, `Pick a date`. Clearing sets the value to `null`, which is how
 * the caller learns to remove `schedule` entirely — the picker never decides what a cleared
 * date means to an Activity, because a primitive knows no domain (`repo-structure.md` §2.2).
 *
 * **`today` is a required prop, not a clock.** `packages/ui` reads no time source: a
 * primitive that called `new Date()` would resolve `This weekend` differently in a test than
 * on a device, and the rule that catches that is `coding-standards.md` §11 smell 6. The
 * screen supplies the user's own wall date, in their own zone, which is the only place that
 * knows it.
 */
export interface DatePickerProps {
  /** The visible label, and the accessible name of the calendar. */
  label: string;
  value: WallDate | null;
  onChange: (next: WallDate | null) => void;
  /** The user's current wall date, in their own zone. */
  today: WallDate;
  /** Defaults to all five chips in `activities.md` §3.4's order. */
  quickOptions?: readonly DateQuickOption[];
  min?: WallDate;
  max?: WallDate;
  disabled?: boolean;
  testID?: string;
}

export function DatePicker({
  label,
  value,
  onChange,
  today,
  quickOptions = DATE_QUICK_OPTIONS,
  min,
  max,
  disabled = false,
  testID,
}: DatePickerProps) {
  const theme = useTheme();
  const [calendarOpen, setCalendarOpen] = useState(false);

  /**
   * A quick chip reads as selected when the current value is the date it would set. `pick` is
   * selected instead when a date is set that no other offered chip accounts for — so a date
   * chosen from the calendar still shows something selected rather than leaving the row
   * looking untouched.
   */
  const quickDates = quickOptions.map((option) => resolveQuickDate(option, today));
  const matchedByChip = value !== null && quickDates.includes(value);

  const isSelected = (option: DateQuickOption, index: number): boolean =>
    option === 'pick' ? value !== null && !matchedByChip : value === quickDates[index];

  const choose = (option: DateQuickOption, index: number) => {
    if (option === 'pick') {
      setCalendarOpen(true);
      return;
    }

    const next = quickDates[index];
    /**
     * Outside a caller's own `min`/`max` window the chip is inert rather than clamped to the
     * boundary. Clamping would write a date the user did not pick, which is the same mistake
     * as inferring one.
     */
    if (next !== undefined && next !== null && isWallDateInRange(next, min, max)) {
      onChange(next);
    }
  };

  return (
    <View testID={testID} style={{ gap: theme.space[2] }}>
      <Text variant="footnoteStrong" color="textSecondary">
        {label}
      </Text>

      <View
        style={{
          flexDirection: 'row',
          flexWrap: 'wrap',
          // `design-system.md` §9: never less than 8 pt between adjacent hit targets.
          gap: theme.space[3],
        }}
      >
        {quickOptions.map((option, index) => (
          <Chip
            key={option}
            label={DATE_QUICK_LABELS[option]}
            selected={isSelected(option, index)}
            disabled={disabled}
            onPress={() => choose(option, index)}
          />
        ))}
      </View>

      {value === null ? null : (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space[3] }}>
          <Text variant="body" color="textPrimary">
            {formatWallDate(value)}
          </Text>
          <IconButton
            icon={Close}
            label={`Clear ${label}`}
            disabled={disabled}
            onPress={() => onChange(null)}
          />
        </View>
      )}

      <Sheet open={calendarOpen} onClose={() => setCalendarOpen(false)} title={label}>
        <DateSurface
          label={label}
          value={value}
          today={today}
          {...(min === undefined ? {} : { min })}
          {...(max === undefined ? {} : { max })}
          onChange={onChange}
        />
        {/*
          `Done` commits the day the calendar is showing — see the same note in `TimePicker`.
          With nothing set the surface opens on `today`, so `Pick a date` → `Done` means today
          rather than meaning nothing. `✕` and the scrim still leave without choosing.
        */}
        <Button
          label="Done"
          onPress={() => {
            if (value === null) onChange(today);
            setCalendarOpen(false);
          }}
        />
      </Sheet>
    </View>
  );
}
