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
  /** Called only when Done commits the wheel's visible value. */
  onConfirm?: (value: WallTime) => void;
  /** Optional compact trigger copy; the wheel keeps `label` as its accessible name. */
  triggerLabel?: string;
  /** The step the wheel offers. 5 throughout this product. */
  minuteInterval?: number;
  /** Whether the clear affordance renders. */
  allowClear?: boolean;
  /**
   * Where the wheel opens when nothing is set yet. A meal form passes its slot's time here so
   * the wheel opens at dinner rather than at nine in the morning.
   *
   * It is a starting position, not a value — **until the user confirms it**. Nothing is
   * written by opening the sheet; `Done` writes whatever the wheel is showing, and dismissing
   * writes nothing. This used to say "nothing is written until the user picks", which meant a
   * user who agreed with the wheel's opening position had no way to say so.
   */
  openAt?: WallTime;
  /** Keeps the wheel inside a sheet that is already open, avoiding a nested native modal. */
  presentation?: 'sheet' | 'inline';
  disabled?: boolean;
  testID?: string;
}

export function TimePicker({
  label,
  value,
  onChange,
  onConfirm,
  triggerLabel,
  minuteInterval = 5,
  allowClear = true,
  openAt = '09:00',
  presentation = 'sheet',
  disabled = false,
  testID,
}: TimePickerProps) {
  const theme = useTheme();
  const [wheelOpen, setWheelOpen] = useState(false);

  const confirm = () => {
    const committed = value ?? openAt;
    if (value === null) onChange(committed);
    onConfirm?.(committed);
    setWheelOpen(false);
  };

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
          label={
            triggerLabel ??
            (value === null ? `Set a ${label.toLowerCase()}` : formatWallTime(value))
          }
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

      {presentation === 'inline' ? (
        wheelOpen ? (
          <View style={{ gap: theme.space[3] }}>
            <TimeSurface
              label={label}
              value={value}
              minuteInterval={minuteInterval}
              fallback={openAt}
              onChange={onChange}
            />
            <Button label="Done" onPress={confirm} />
            <Button label="Cancel" variant="ghost" onPress={() => setWheelOpen(false)} />
          </View>
        ) : null
      ) : (
        <Sheet open={wheelOpen} onClose={() => setWheelOpen(false)} title={label}>
          <TimeSurface
            label={label}
            value={value}
            minuteInterval={minuteInterval}
            fallback={openAt}
            onChange={onChange}
          />
          {/*
          **`Done` commits what the wheel is showing.**

          The wheel renders `value ?? openAt`, so with nothing set it displays a real time the
          user can read — and `onChange` only fires when the spinner actually moves. Opening
          the sheet, agreeing with what it already says, and tapping `Done` therefore used to
          write nothing at all: a confirm button that discarded the value it was displaying.

          Dismissing is still the way to set nothing. `✕` and the scrim run `onClose`, which
          only closes — so the two exits mean different things, which is what makes committing
          here safe: `Done` is the only path that writes.
        */}
          <Button label="Done" onPress={confirm} />
        </Sheet>
      )}
    </View>
  );
}
