import { useState } from 'react';
import { View } from 'react-native';
import { useTheme } from '../theme/index';
import { Button } from './Button';
import { Chip } from './Chip';
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
    <View testID={testID} style={{ gap: theme.space[3] }}>
      {/** `caption` — the frames' tracked uppercase section label above a group of controls. */}
      <Text variant="caption" color="textMuted">
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

        {/**
         * **A named control, not a bare ✕.** The frames pair the value with `Remove time` as a
         * second outlined pill; an unlabelled cross beside a pill is the exact ambiguity this
         * screen was reported for — nothing on it said whether the glyph was a control, a
         * status, or decoration.
         */}
        {allowClear && value !== null ? (
          <Chip
            label={`Remove ${label.toLowerCase()}`}
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
            {/**
             * **A row, not a column.** `Done` and `Cancel` were two full-width buttons stacked
             * on top of each other, which read as two unrelated decisions rather than as a
             * commit and its escape. A confirm pair belongs on one line, commit first.
             *
             * When this picker is presented as its own `Sheet` the pair goes in the sheet's
             * `actions` slot instead — §6.1 gives that placement to `Sheet`, not to the control
             * inside it. Inline, there is no sheet to own it, so it sits here in the same shape.
             */}
            <View style={{ flexDirection: 'row', gap: theme.space[3] }}>
              <View style={{ flex: 1 }}>
                <Button label="Done" fullWidth onPress={confirm} />
              </View>
              <Button
                label="Cancel"
                variant="ghost"
                onPress={() => setWheelOpen(false)}
              />
            </View>
          </View>
        ) : null
      ) : (
        <Sheet
          open={wheelOpen}
          onClose={() => setWheelOpen(false)}
          title={label}
          detent="fit"
          actions={<Button label="Done" fullWidth onPress={confirm} />}
        >
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
        </Sheet>
      )}
    </View>
  );
}
