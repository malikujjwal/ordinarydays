import { View } from 'react-native';
import { useTheme } from '../theme/index';

/**
 * The one sanctioned progress bar (`design-system.md` §1, §6, §7.1).
 *
 * Used for exactly two things: Today's day line and a list card's fill line. There are no
 * rings of progress anywhere else in the product.
 *
 * **This is information, not celebration.** It never animates on completion beyond a `base`
 * width ease, it carries no percentage text of its own, and at `0` it renders an empty track
 * rather than hiding — a bar that disappeared at zero would make "nothing done yet" look
 * like "nothing to do".
 */
export interface ProgressBarProps {
  /** 0–1. Clamped, because a caller computing `done / total` can hand over `NaN` at zero. */
  value: number;
  tone?: 'accent' | 'neutral';
  /** The accessible description, e.g. `2 of 6 done`. Without it the bar is announced as bare. */
  label?: string;
  testID?: string;
}

export function ProgressBar({ value, tone = 'accent', label, testID }: ProgressBarProps) {
  const theme = useTheme();
  const clamped = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;

  return (
    <View
      // `aria-*` as well: React Native Web does not project `accessibilityValue` onto the
      // DOM, so a bar declared only that way announces a role and no value.
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped * 100)}
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(clamped * 100) }}
      {...(label === undefined ? {} : { accessibilityLabel: label, 'aria-label': label })}
      testID={testID}
      style={{
        height: 4,
        borderRadius: theme.radius.pill,
        backgroundColor: theme.colors.border,
        overflow: 'hidden',
      }}
    >
      <View
        style={{
          width: `${clamped * 100}%`,
          height: '100%',
          borderRadius: theme.radius.pill,
          backgroundColor:
            tone === 'accent' ? theme.colors.accent : theme.colors.textSecondary,
        }}
      />
    </View>
  );
}
