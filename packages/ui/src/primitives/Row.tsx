import { View } from 'react-native';
import type { ActivityTypeName } from '../theme/colors';
import { useTheme } from '../theme/index';
import { Text } from './Text';
import { Touchable } from './Touchable';

/**
 * The list row (`design-system.md` §6, §7.1).
 *
 * Rows are **not cards**: no radius, no elevation, a hairline between them. The title is the
 * largest, darkest thing on the row and everything else is smaller and lighter — "content is
 * the interface".
 *
 * **Tapping the body opens; it never mutates** (`interaction-contract.md` U1). The only
 * control that mutates from a row is the checkbox, and it is a separate target with at least
 * `space[3]` between it and the body — which this component applies rather than trusting a
 * caller to.
 */
export interface RowProps {
  title: string;
  subtitle?: string;
  /** The leading control — a `Checkbox` for tasks, a type marker otherwise. */
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  onPress?: () => void;
  /** The type marker's accent, for the non-interactive dot beside a non-task row. */
  accent?: ActivityTypeName;
  /** Completed and EARLIER TODAY rows. */
  dimmed?: boolean;
  /** Completed rows additionally strike the title. */
  struck?: boolean;
  accessibilityLabel?: string;
  accessibilityActions?: { name: string; label: string }[];
  onAccessibilityAction?: (event: { nativeEvent: { actionName: string } }) => void;
  testID?: string;
}

export function Row({
  title,
  subtitle,
  leading,
  trailing,
  onPress,
  accent,
  dimmed = false,
  struck = false,
  accessibilityLabel,
  accessibilityActions,
  onAccessibilityAction,
  testID,
}: RowProps) {
  const theme = useTheme();

  const body = (
    <View style={{ flex: 1, gap: theme.space[1] }}>
      <Text
        variant="body"
        color={dimmed ? 'textSecondary' : 'textPrimary'}
        struck={struck}
      >
        {title}
      </Text>
      {subtitle === undefined ? null : (
        <Text variant="subhead" color="textSecondary" numberOfLines={1}>
          {subtitle}
        </Text>
      )}
    </View>
  );

  const content = (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        // The ≥ 8 pt rule between adjacent targets, applied here so no caller has to.
        gap: theme.space[4],
        minHeight: theme.layout.rowMinHeight,
        paddingVertical: theme.space[5],
        opacity: dimmed ? 0.72 : 1,
      }}
    >
      {leading}
      {accent === undefined ? null : (
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={{
            width: 8,
            height: 8,
            borderRadius: theme.radius.pill,
            borderWidth: 1.5,
            borderColor: theme.typeAccent(accent).accent,
          }}
        />
      )}
      {body}
      {trailing}
    </View>
  );

  if (onPress === undefined) {
    return (
      <View
        testID={testID}
        style={{ borderBottomWidth: 1, borderBottomColor: theme.colors.border }}
      >
        {content}
      </View>
    );
  }

  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      {...(accessibilityActions === undefined ? {} : { accessibilityActions })}
      {...(onAccessibilityAction === undefined ? {} : { onAccessibilityAction })}
      onPress={onPress}
      testID={testID}
      style={{ borderBottomWidth: 1, borderBottomColor: theme.colors.border }}
    >
      {content}
    </Touchable>
  );
}
