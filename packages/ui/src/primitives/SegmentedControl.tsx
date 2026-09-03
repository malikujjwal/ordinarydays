import { View } from 'react-native';
import { useTheme } from '../theme/index';
import { Text } from './Text';
import { Touchable } from './Touchable';

/**
 * The stage switcher (`design-system.md` §6, §7.3) — `Needs a date · Upcoming · Past`.
 *
 * A `surfaceSunken` pill track with the active segment raised onto `surfaceRaised` + `e1`.
 * `count` renders as a `footnote` beside the label; the **Plans** switcher never passes one
 * (§7.3, corrected 2026-08-25: §1.3.2 forbids every stage badge and count, so there is no
 * badge-worthy number to render there — the plans chrome test enforces it).
 *
 * `role="tablist"` with `selected` state per segment, so a screen reader announces position
 * rather than reading three unrelated buttons.
 */
export interface Segment {
  label: string;
  count?: number;
}

export interface SegmentedControlProps {
  segments: Segment[];
  selectedIndex: number;
  onChange?: (index: number) => void;
  /** Reduces only horizontal inset when four counted labels must share a compact phone row. */
  compact?: boolean;
  testID?: string;
}

export function SegmentedControl({
  segments,
  selectedIndex,
  onChange,
  compact = false,
  testID,
}: SegmentedControlProps) {
  const theme = useTheme();

  return (
    <View
      accessibilityRole="tablist"
      testID={testID}
      style={{
        flexDirection: 'row',
        backgroundColor: theme.colors.surfaceSunken,
        borderRadius: theme.radius.md,
        padding: theme.space[1],
        gap: theme.space[1],
      }}
    >
      {segments.map((segment, index) => {
        const active = index === selectedIndex;
        return (
          <Touchable
            key={segment.label}
            role="tab"
            aria-selected={active}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            aria-label={
              segment.count === undefined
                ? segment.label
                : `${segment.label}, ${segment.count}`
            }
            accessibilityLabel={
              segment.count === undefined
                ? segment.label
                : `${segment.label}, ${segment.count}`
            }
            onPress={() => onChange?.(index)}
            style={[
              {
                flex: 1,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: theme.space[2],
                borderRadius: theme.radius.md - 2,
                paddingHorizontal: compact ? theme.space[3] : theme.space[4],
                backgroundColor: active ? theme.colors.surfaceRaised : 'transparent',
              },
              active ? theme.elevation('e1') : null,
            ]}
          >
            <Text
              variant={active ? 'footnoteStrong' : 'footnote'}
              color={active ? 'textPrimary' : 'textSecondary'}
              numberOfLines={1}
            >
              {segment.label}
            </Text>
            {segment.count === undefined ? null : (
              <Text variant="footnote" color="textSecondary">
                {String(segment.count)}
              </Text>
            )}
          </Touchable>
        );
      })}
    </View>
  );
}
