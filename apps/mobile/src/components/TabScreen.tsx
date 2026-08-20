import { Text, useBreakpoint, useTheme } from '@od/ui';
import type { ReactNode } from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

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
  /** Optional content between the title and trailing action, in a stable flexible slot. */
  titleAccessory?: ReactNode;
  /**
   * The date line **above** the serif title (`design-system.md` §7.1, P2-44).
   *
   * It lives here rather than in a `TodayHeader` the screen renders itself, because §7.1 puts
   * it above the title and this component owns that position — a screen rendering its own
   * caption would have to render it below, or reach around the header, and the phase task is
   * explicit that reordering the header is a thing to raise rather than do.
   *
   * Today is the only caller. Plans and Lists pass neither this nor {@link belowHeader} and
   * render byte-identically to before, which is a test.
   */
  caption?: string;
  /** The slot beneath the header row — Today's day progress bar, and nothing else so far. */
  belowHeader?: ReactNode;
  /**
   * Drops the body's horizontal padding so a scrolling child can own it instead — added
   * 2026-08-17.
   *
   * With the padding on the container, a `ScrollView` child is inset by it and **its scrollbar
   * rides inside the content area**, over the right-hand edge of every card and row. Moving the
   * gutter into the scroll's own content lets the bar sit at the true edge with the content
   * still inset from it, which is what the founder meant by "apps have a slight margin on both
   * left and right sides".
   */
  bleedBody?: boolean;
}

/** The horizontal gutter a tab's own scroll content must apply when it bleeds the body. */
export function useTabGutter(): number {
  const theme = useTheme();
  return useBreakpoint() === 'compact' ? theme.space[5] : theme.space[7];
}

export function TabScreen({
  title,
  children,
  testID,
  headerAction,
  titleAccessory,
  caption,
  belowHeader,
  bleedBody = false,
}: TabScreenProps) {
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
          paddingBottom: theme.space[4],
        }}
      >
        {caption === undefined ? null : (
          <Text variant="caption" color="textSecondary" testID={`${testID}-caption`}>
            {caption}
          </Text>
        )}
        <View
          style={{
            minHeight: theme.layout.hitTarget,
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.space[3],
          }}
        >
          <Text variant="display" color="textDisplay" accessibilityRole="header">
            {title}
          </Text>
          {titleAccessory === undefined ? null : (
            /**
             * This flexible middle slot always exists while its child renders, even when that
             * child returns nothing. The title stays pinned left and actions stay pinned right;
             * on a narrow screen only the accessory may ellipsise.
             */
            <View
              testID={`${testID}-title-accessory-slot`}
              style={{ flex: 1, minWidth: 0, alignItems: 'flex-start' }}
            >
              {titleAccessory}
            </View>
          )}
          {headerAction === undefined ? null : (
            <View
              style={{
                flexShrink: 0,
                ...(titleAccessory === undefined ? { marginLeft: 'auto' } : {}),
              }}
            >
              {headerAction}
            </View>
          )}
        </View>
        {belowHeader === undefined ? null : (
          /**
           * The same step above the bar as the header block leaves below it, so the bar sits
           * evenly between the title and the first card rather than hugging the title.
           */
          <View style={{ paddingTop: theme.space[4] }}>{belowHeader}</View>
        )}
      </View>

      <View
        testID="tab-screen-body"
        style={{
          flex: 1,
          width: '100%',
          alignSelf: 'center',
          ...(compact ? {} : { maxWidth: 720 }),
          ...(bleedBody ? {} : { paddingHorizontal: gutter }),
        }}
      >
        {children}
      </View>
    </View>
  );
}
