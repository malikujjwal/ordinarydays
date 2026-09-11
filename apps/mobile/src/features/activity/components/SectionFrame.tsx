import { SectionHeader, Text, Touchable, useTheme } from '@od/ui';
import type { ReactNode, Ref } from 'react';
import { View } from 'react-native';

/**
 * One Plan-detail section's frame (P3-37, `plans-and-lists.md` §2.1 amended 2026-08-25):
 * caption header with a trailing figure, then its rows. Sections exist only once they hold
 * something; the frame never renders an empty heading because no section mounts it empty.
 *
 * `ruled` is the 2026-09-10 heading grammar for Details, Ingredients, Notes and Settings: a
 * caption heading closed by a hairline, then rows that each close on their own rule.
 */
export interface SectionFrameProps {
  label: string;
  /** A quiet fact beside the label — `4`, `1 of 4 on a list`. */
  meta?: string;
  trailing?: string;
  /** Spoken name for a tappable trailing control; defaults to `trailing`. */
  trailingAccessibilityLabel?: string;
  onTrailingPress?: () => void;
  /** Where focus returns after an editor closes (the Notes `Edit`). */
  trailingRef?: Ref<View>;
  trailingTestID?: string;
  /** A hairline under the heading row. */
  ruled?: boolean;
  children: ReactNode;
  testID?: string;
}

export function SectionFrame({
  label,
  meta,
  trailing,
  trailingAccessibilityLabel,
  onTrailingPress,
  trailingRef,
  trailingTestID,
  ruled = false,
  children,
  testID,
}: SectionFrameProps) {
  const theme = useTheme();
  return (
    <View
      style={{ gap: ruled ? 0 : theme.space[2] }}
      {...(testID === undefined ? {} : { testID })}
    >
      {/**
       * **The label's box always has a definite width** (device report, 2026-09-11). The
       * 2026-09-10 version sat the heading in a `flexShrink: 1` wrapper inside a nested
       * baseline row so `meta` could hug it. On iOS every heading on the screen vanished:
       * `SectionHeader` gives its caption a `flex: 1` box, which Yoga resolves to a zero flex
       * basis, so a content-sized parent measures it at 0 pt wide and the caption lays out
       * into nothing. The browser (and so every jsdom test) sizes the same tree from the
       * text's max-content width, which is why only the phone showed it. So the heading gets
       * a `flex: 1` box of its own, `meta` follows it in a plain row, and rows centre rather
       * than baseline-align — Yoga's baseline walks nested views and is the least
       * predictable of the alignments. `meta`'s bottom inset mirrors `SectionHeader`'s own,
       * so the two centre on the same line.
       */}
      <View
        style={{
          flexDirection: 'row',
          flexWrap: 'wrap',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: theme.space[2],
          ...(ruled
            ? { borderBottomWidth: 1, borderBottomColor: theme.colors.border }
            : {}),
        }}
      >
        <View
          style={{
            flex: 1,
            minWidth: 0,
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.space[3],
          }}
        >
          <View style={{ flex: 1, minWidth: 0 }}>
            <SectionHeader title={label} />
          </View>
          {meta === undefined ? null : (
            <View style={{ paddingBottom: theme.space[2] }}>
              <Text
                variant="footnote"
                color="textMuted"
                {...(testID === undefined ? {} : { testID: `${testID}-meta` })}
              >
                {meta}
              </Text>
            </View>
          )}
        </View>
        {trailing === undefined ? null : onTrailingPress === undefined ? (
          <Text variant="footnoteStrong" color="textSecondary">
            {trailing}
          </Text>
        ) : (
          <Touchable
            accessibilityRole="button"
            accessibilityLabel={trailingAccessibilityLabel ?? trailing}
            onPress={onTrailingPress}
            {...(trailingRef === undefined ? {} : { elementRef: trailingRef })}
            {...(trailingTestID === undefined ? {} : { testID: trailingTestID })}
            style={{
              minHeight: theme.layout.hitTarget,
              justifyContent: 'center',
              flexShrink: 1,
              maxWidth: '100%',
            }}
          >
            <Text variant="footnoteStrong" color="textAction">
              {trailing}
            </Text>
          </Touchable>
        )}
      </View>
      {children}
    </View>
  );
}
