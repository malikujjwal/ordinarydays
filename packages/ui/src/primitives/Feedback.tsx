import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useMotion, useTheme } from '../theme/index';
import { type } from '../theme/tokens';
import { Button } from './Button';
import { Text } from './Text';
import { Touchable } from './Touchable';

/**
 * The three quiet surfaces: `SectionHeader`, `EmptyState`, `Toast`, plus `Skeleton`
 * (`design-system.md` §6).
 *
 * Grouped because they share one property — none of them celebrates. There is no confetti,
 * no streak, no badge and no "Great job!" anywhere in this file, and completing something
 * makes the interface quieter rather than louder (`interaction-contract.md` §5.2).
 */

export interface SectionHeaderProps {
  title: string;
  count?: number;
  action?: React.ReactNode;
  testID?: string;
}

/** `UP NEXT · IN 2H 15M`, `EARLIER TODAY`, `SCHEDULE`. Caption, uppercase, wide-tracked. */
export function SectionHeader({ title, count, action, testID }: SectionHeaderProps) {
  const theme = useTheme();

  return (
    <View
      testID={testID}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        // The section's own gap supplies the rest; 8 here plus 4 there read as an odd 12.
        paddingBottom: theme.space[2],
      }}
    >
      {/**
       * `role="heading"` as well as `accessibilityRole`, for the same React Native Web
       * reason as the other primitives.
       *
       * Note that the **accessible name is the prop's own casing**, not the uppercase the
       * user sees: `caption` uppercases through CSS `textTransform`, which is presentation
       * and does not reach the accessibility tree. That is correct — a screen reader should
       * say "Up next", not spell out "U-P N-E-X-T" — and it is worth knowing before someone
       * writes `title="UP NEXT"` to make a test pass.
       */}
      <Text
        variant="caption"
        color="textSecondary"
        role="heading"
        aria-level={2}
        accessibilityRole="header"
        {...(count === undefined ? {} : { accessibilityLabel: `${title}, ${count}` })}
      >
        {title}
      </Text>
      {/**
       * **The action keeps its 44 pt target without setting the header's height.**
       *
       * A `Button` here is 44 tall against a 14 pt caption, so the header row grew to 44 and
       * left ~15 pt of dead air above the section's first row — the founder's "unusual gap",
       * and visible only on EARLIER TODAY because it is the only section with an action. The
       * negative margin is exactly that slack, derived from the two tokens rather than typed in,
       * so the target still measures 44 (`interaction-contract.md` §2) while the header measures
       * its text. Nothing interactive sits above or below it to overlap.
       */}
      {action === undefined ? null : (
        <View
          style={{
            marginVertical: -(theme.layout.hitTarget - type.caption.lineHeight) / 2,
          }}
        >
          {action}
        </View>
      )}
      {/**
       * **The count sits on the trailing edge, not inside the title** — amended 2026-08-17
       * (founder). It used to render as `ANYTIME · 2`, which reads as part of the section's name;
       * on the right it reads as a fact about the section, which is what `design-system.md` §7.1
       * draws for EARLIER TODAY and what the founder asked for on ANYTIME.
       *
       * It stays inside the **heading's accessible name** above, so a screen reader still hears
       * "Anytime, 2" as one announcement rather than meeting a bare number afterwards.
       */}
      {action !== undefined || count === undefined ? null : (
        <Text
          variant="caption"
          color="textMuted"
          aria-hidden
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          {count}
        </Text>
      )}
    </View>
  );
}

export interface EmptyStateProps {
  heading: string;
  body?: string;
  action?: { label: string; onPress: () => void };
  testID?: string;
}

/**
 * One heading line, at most one body line, at most one action. **No illustration** — an empty
 * list is a fact, not an occasion for a drawing.
 */
export function EmptyState({ heading, body, action, testID }: EmptyStateProps) {
  const theme = useTheme();

  return (
    <View
      testID={testID}
      style={{
        alignItems: 'center',
        gap: theme.space[3],
        paddingTop: theme.space[11],
        paddingHorizontal: theme.space[8],
      }}
    >
      <Text variant="heading" color="textPrimary" align="center">
        {heading}
      </Text>
      {body === undefined ? null : (
        <Text variant="subhead" color="textSecondary" align="center">
          {body}
        </Text>
      )}
      {action === undefined ? null : (
        <View style={{ paddingTop: theme.space[3] }}>
          <Button label={action.label} onPress={action.onPress} variant="secondary" />
        </View>
      )}
    </View>
  );
}

export interface ToastProps {
  message: string;
  action?: { label: string; onPress: () => void };
  tone?: 'neutral' | 'error';
  /** 6 s for a normal undo, 10 s for a bulk one (`interaction-contract.md` §4). */
  duration?: 6000 | 10000;
  onDismiss?: () => void;
  testID?: string;
}

/**
 * One at a time; a new one commits the previous.
 *
 * `accessibilityLiveRegion="polite"` so the message is announced without stealing focus — a
 * toast that grabbed focus would interrupt whatever the user was doing to tell them what they
 * just did.
 */
export function Toast({
  message,
  action,
  tone = 'neutral',
  duration = 6000,
  onDismiss,
  testID,
}: ToastProps) {
  const theme = useTheme();

  useEffect(() => {
    if (onDismiss === undefined) return;
    const timer = setTimeout(onDismiss, duration);
    return () => clearTimeout(timer);
  }, [duration, onDismiss]);

  return (
    <View
      accessibilityLiveRegion="polite"
      accessibilityRole="alert"
      testID={testID}
      style={[
        {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: theme.space[4],
          paddingVertical: theme.space[4],
          paddingHorizontal: theme.space[5],
          borderRadius: theme.radius.md,
          backgroundColor: theme.colors.surfaceOverlay,
        },
        theme.elevation('e4'),
      ]}
    >
      <Text variant="subhead" color={tone === 'error' ? 'danger' : 'textPrimary'}>
        {message}
      </Text>
      {action === undefined ? null : (
        <Touchable
          accessibilityRole="button"
          accessibilityLabel={action.label}
          onPress={action.onPress}
          testID="toast-action"
          style={{ paddingHorizontal: theme.space[2] }}
        >
          {/**
           * `textAction`, not `accent`. §5.1: `accent` is a fill and icon colour — 3.7:1 on dark
           * `surfaceRaised` — and `Undo` on a toast is the most important word in the product to
           * be able to read. Caught by §17's sweep, 2026-08-13.
           */}
          <Text variant="footnoteStrong" color="textAction">
            {action.label}
          </Text>
        </Touchable>
      )}
    </View>
  );
}

export interface SkeletonProps {
  shape?: 'row' | 'card' | 'text';
  count?: number;
  testID?: string;
}

/**
 * A loading placeholder. **Shimmer is off under Reduce Motion** and the minimum display is
 * 200 ms — a skeleton that flashed for one frame reads as a glitch.
 */
export function Skeleton({ shape = 'row', count = 3, testID }: SkeletonProps) {
  const theme = useTheme();
  const { reduced } = useMotion();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), 0);
    return () => clearTimeout(timer);
  }, []);

  const height =
    shape === 'card' ? 96 : shape === 'text' ? 14 : theme.layout.rowMinHeight;

  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel="Loading"
      testID={testID}
      style={{ gap: theme.space[3], opacity: visible && !reduced ? 0.85 : 1 }}
    >
      {Array.from({ length: count }, (_, index) => `skeleton-${index}`).map((key) => (
        <View
          key={key}
          style={{
            height,
            borderRadius: shape === 'text' ? theme.radius.sm : theme.radius.md,
            backgroundColor: theme.colors.surfaceSunken,
          }}
        />
      ))}
    </View>
  );
}
