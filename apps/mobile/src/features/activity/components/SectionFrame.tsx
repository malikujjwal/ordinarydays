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
      <View
        style={{
          flexDirection: 'row',
          flexWrap: 'wrap',
          justifyContent: 'space-between',
          alignItems: 'baseline',
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
            alignItems: 'baseline',
            gap: theme.space[3],
          }}
        >
          <View style={{ flexShrink: 1 }}>
            <SectionHeader title={label} />
          </View>
          {meta === undefined ? null : (
            <Text variant="footnote" color="textMuted">
              {meta}
            </Text>
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
