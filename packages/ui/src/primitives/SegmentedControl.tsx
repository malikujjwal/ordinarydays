import { View } from 'react-native';
import { useTheme } from '../theme/index';
import { Text } from './Text';
import { Touchable } from './Touchable';

/**
 * The stage switcher (`design-system.md` §6, §7.3) — `Needs a date · Upcoming · Past`.
 *
 * A `surfaceSunken` pill track with the active segment raised onto `surfaceRaised` + `e1`.
 * Counts render as a `footnote` beside the label where a stage carries a badge-worthy number.
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
  testID?: string;
}

export function SegmentedControl({
  segments,
  selectedIndex,
  onChange,
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
                paddingHorizontal: theme.space[4],
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
