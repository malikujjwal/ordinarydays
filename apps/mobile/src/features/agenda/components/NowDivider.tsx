import { formatWallTime, Text, useTheme } from '@od/ui';
import { View } from 'react-native';

export interface NowDividerProps {
  /** The current wall minute, from the screen's existing one-minute ticker. */
  currentMinute: string;
}

/**
 * `NOW ────────────── 12:15 PM` (`design-system.md` §7.1, P2-44).
 *
 * ## Where it sits, and why that took a founder decision
 *
 * §7.1 places it "between EARLIER TODAY and what remains". Under the section order
 * `today-and-tasks.md` §2 fixed — UP NEXT → SCHEDULE → ANYTIME → EARLIER TODAY — there was no
 * such position: EARLIER TODAY rendered **last**, so nothing remained after it. §2 outranks
 * §7.1, so the order could not simply be bent to fit the picture, and P2-44 was written to bring
 * the founder the candidates rather than pick one.
 *
 * The founder's 2026-08-17 answer moved the section instead: EARLIER TODAY now renders directly
 * beneath the UP NEXT card and above SCHEDULE, and this divider marks the join. §7.1's sentence
 * is then literally true, and the screen reads top-to-bottom as one timeline — completed
 * mornings, the present, then what is still coming.
 *
 * **Purely presentational.** It owns no data, moves nothing between sections, and is driven by
 * the ticker the screen already runs for UP NEXT. It is hidden from assistive technology: a
 * screen reader hears the sections and their rows, and a decorative rule announcing "now" between
 * them adds a landmark that is not one.
 */
export function NowDivider({ currentMinute }: NowDividerProps) {
  const theme = useTheme();

  return (
    <View
      aria-hidden
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      testID="today-now-divider"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space[4],
        // No padding of its own: the screen's own section gap spaces it, like every other block.
        paddingVertical: theme.space[0],
      }}
    >
      {/**
       * **The two labels are `textAction`, the rule is `accent`** — corrected 2026-08-17 after
       * the axe gate caught it.
       *
       * `design-system.md` §7.1 writes this divider as "`NOW` in `caption` `accent` ... the
       * current time right-aligned in `footnoteStrong` `accent`", and built that way it measured
       * **4.34:1** on light `surface` — below `interaction-contract.md` §6.4's 4.5:1 for readable
       * text, and exactly what §5.1 means by "`accent` is never body text on `surface`". §7.1 is
       * craft; the contrast gate is behaviour, so the gate wins and §7.1 gains a dated note.
       *
       * The hairline keeps `accent`: it is a graphic, owing 3:1, which it clears.
       */}
      <Text variant="caption" color="textAction">
        Now
      </Text>
      <View style={{ flex: 1, height: 1, backgroundColor: theme.colors.accent }} />
      <Text variant="footnoteStrong" color="textAction">
        {formatWallTime(currentMinute)}
      </Text>
    </View>
  );
}
