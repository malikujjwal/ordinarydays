import { useState } from 'react';
import { View } from 'react-native';
import { Close } from '../icons/index';
import { useTheme } from '../theme/index';
import { Button } from './Button';
import { Chip } from './Chip';
import { IconButton } from './IconButton';
import { TimeSurface } from './pickerSurface';
import { Sheet } from './Sheet';
import { Text } from './Text';
import { formatWallTime, type WallTime } from './wallClock';

/**
 * A time of day, in 5-minute steps (`design-system.md` §6, `activities.md` §3.4).
 *
 * Two behaviours the caller owns rather than this component:
 *
 * - **Enablement.** A time only means something once a date is set, so the form passes
 *   `disabled` — the picker does not go looking for a sibling date field, because a primitive
 *   knows no form.
 * - **What a cleared time means.** `onChange(null)` says the user cleared it; that it makes
 *   the item all-day, and that all-day renders as `Anytime`, is the screen's knowledge.
 */
export interface TimePickerProps {
  /** The visible label, and the accessible name of the wheel. */
  label: string;
  value: WallTime | null;
  onChange: (next: WallTime | null) => void;
  /** The step the wheel offers. 5 throughout this product. */
  minuteInterval?: number;
  /** Whether the clear affordance renders. */
  allowClear?: boolean;
  /**
   * Where the wheel opens when nothing is set yet. It is a starting position and never a
   * value: nothing is written until the user picks. A meal form passes its slot's time here
   * so the wheel opens at dinner rather than at nine in the morning.
   */
  openAt?: WallTime;
  disabled?: boolean;
  testID?: string;
}

export function TimePicker({
  label,
  value,
  onChange,
  minuteInterval = 5,
  allowClear = true,
  openAt = '09:00',
  disabled = false,
  testID,
}: TimePickerProps) {
  const theme = useTheme();
  const [wheelOpen, setWheelOpen] = useState(false);

  return (
    <View testID={testID} style={{ gap: theme.space[2] }}>
      <Text variant="footnoteStrong" color="textSecondary">
        {label}
      </Text>

      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          // `design-system.md` §9: never less than 8 pt between adjacent hit targets.
          gap: theme.space[3],
        }}
      >
        <Chip
          label={value === null ? `Set a ${label.toLowerCase()}` : formatWallTime(value)}
          selected={value !== null}
          disabled={disabled}
          onPress={() => setWheelOpen(true)}
        />

        {allowClear && value !== null ? (
          <IconButton
            icon={Close}
            label={`Clear ${label}`}
            disabled={disabled}
            onPress={() => onChange(null)}
          />
        ) : null}
      </View>

      <Sheet open={wheelOpen} onClose={() => setWheelOpen(false)} title={label}>
        <TimeSurface
          label={label}
          value={value}
          minuteInterval={minuteInterval}
          fallback={openAt}
          onChange={onChange}
        />
        <Button label="Done" onPress={() => setWheelOpen(false)} />
      </Sheet>
    </View>
  );
}
