import { Text, useBreakpoint, useTheme } from '@od/ui';
import type { ReactNode } from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ADD_SIZE } from '@/features/shell/model/tabs';

/**
 * A tab's chrome: the screen title, and the column its body sits in (P1-23).
 *
 * In `src/components/` rather than in a feature slice because all three tabs use it and one of
 * them — Plans — is its own feature. `repo-structure.md` §3.2: "if two features need the same
 * thing, it moves up to `src/components/`", and `dependency-cruiser`'s
 * `no-cross-feature-imports` enforces that rather than suggesting it.
 *
 * Headerless navigators, so each screen owns its own header — which is what lets Today's
 * header carry a date and Lists' carry a `New list` action without fighting a shared one.
 *
 * ## Layout at width (`design-system.md` §8)
 *
 * `compact` is a single column at the 16 pt gutter. From `medium` up the column is **capped at
 * 720 pt and centred, with 24 pt gutters** — the rail has already taken the left edge by then,
 * and without the cap a 1280 px browser renders a line of body text the full width of the
 * window.
 *
 * The `expanded` two-pane split is not built: it needs a list pane that owns selection, and
 * the only list in this phase is the flat one on Plans. §8 names the `medium` layout as the
 * fallback below 1200 — "nothing is lost, only rearranged" — and that is what runs here.
 */
export interface TabScreenProps {
  title: string;
  children: ReactNode;
  testID: string;
  headerAction?: ReactNode;
}

export function TabScreen({ title, children, testID, headerAction }: TabScreenProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const compact = useBreakpoint() === 'compact';

  const gutter = compact ? theme.space[5] : theme.space[7];

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface }} testID={testID}>
      <View
        style={{
          width: '100%',
          alignSelf: 'center',
          ...(compact ? {} : { maxWidth: 720 }),
          paddingTop: insets.top + theme.space[5],
          paddingHorizontal: gutter,
          paddingBottom: theme.space[3],
        }}
      >
        <View
          style={{
            minHeight: theme.layout.hitTarget,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: theme.space[4],
          }}
        >
          <Text variant="display" color="textDisplay" accessibilityRole="header">
            {title}
          </Text>
          {headerAction}
        </View>
      </View>

      <View
        style={{
          flex: 1,
          width: '100%',
          alignSelf: 'center',
          ...(compact ? {} : { maxWidth: 720 }),
          paddingHorizontal: gutter,
          /**
           * Clear of the tab bar **and** of the floating `+` above it.
           *
           * This used to add only the bar's height, and its comment claimed the FAB too. It
           * did not: `ShellFrame` puts the button's bottom edge at
           * `insets.bottom + space[11] + space[5]`, so the button's *top* is another `ADD_SIZE`
           * above that — and everything between the old padding and that top edge was content
           * sitting under an opaque 56 pt circle. On a device with a home indicator that is
           * roughly 72 pt of the last row hidden, which is why it read as a bar behind the
           * button rather than as an overlap.
           *
           * Derived from the same constants `ShellFrame` positions the button with, so the two
           * cannot drift apart.
           */
          paddingBottom:
            insets.bottom + theme.space[11] + theme.space[5] + ADD_SIZE + theme.space[3],
        }}
      >
        {children}
      </View>
    </View>
  );
}
