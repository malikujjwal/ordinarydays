import DateTimePicker from '@react-native-community/datetimepicker';
import {
  toWallDate,
  toWallTime,
  type WallDate,
  type WallTime,
  wallDateToDate,
  wallTimeToDate,
} from './wallClock';

/**
 * The **native** calendar and clock surfaces — the platform wheel, per `design-system.md` §6.
 *
 * This is the only forked file in `packages/ui`, and it is forked at the smallest seam that
 * works: `DatePicker` and `TimePicker` themselves are one file each, because their chips,
 * trigger, sheet, labels and clear affordance are identical on both platforms
 * (`tech-stack.md` §3.5 — fork only where the platforms genuinely differ). What differs is
 * one element, so one element is what forks.
 *
 * `pickerSurface.web.tsx` exports the same two components with the same props, and
 * `pickers.test.tsx` asserts that the two export sets match (`coding-standards.md` §8.6).
 */

export interface DateSurfaceProps {
  /** The accessible name. The visible label lives on the picker, not on the surface. */
  label: string;
  value: WallDate | null;
  onChange: (next: WallDate) => void;
  /** Shown when `value` is null, so the calendar opens somewhere sensible. */
  today: WallDate;
  min?: WallDate;
  max?: WallDate;
}

export function DateSurface({
  label,
  value,
  onChange,
  today,
  min,
  max,
}: DateSurfaceProps) {
  return (
    <DateTimePicker
      accessibilityLabel={label}
      value={wallDateToDate(value ?? today)}
      mode="date"
      display="inline"
      {...(min === undefined ? {} : { minimumDate: wallDateToDate(min) })}
      {...(max === undefined ? {} : { maximumDate: wallDateToDate(max) })}
      onChange={(_event, picked) => {
        /**
         * `picked` is undefined when the user dismisses the wheel without choosing. Treating
         * that as a change would write a date nobody selected — the one thing rule 2 of
         * `CLAUDE.md` exists to prevent.
         */
        if (picked !== undefined) onChange(toWallDate(picked));
      }}
    />
  );
}

export interface TimeSurfaceProps {
  label: string;
  value: WallTime | null;
  onChange: (next: WallTime) => void;
  /** The step the wheel offers. 5 everywhere in this product (`activities.md` §3.4). */
  minuteInterval: number;
  /** Where the wheel opens when no time is set yet. */
  fallback: WallTime;
}

export function TimeSurface({
  label,
  value,
  onChange,
  minuteInterval,
  fallback,
}: TimeSurfaceProps) {
  return (
    <DateTimePicker
      accessibilityLabel={label}
      value={wallTimeToDate(value ?? fallback)}
      mode="time"
      display="spinner"
      minuteInterval={minuteInterval as 1 | 2 | 3 | 4 | 5 | 6 | 10 | 12 | 15 | 20 | 30}
      onChange={(_event, picked) => {
        if (picked !== undefined) onChange(toWallTime(picked));
      }}
    />
  );
}
