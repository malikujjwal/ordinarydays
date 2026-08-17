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
  /**
   * Which ink the subtitle takes — added 2026-08-16 (P2-43).
   *
   * `content` is `textSecondary` and is the default, because an agenda row's subtitle is the
   * **user's own data** — `Meal · Dinner`, the location, `S2 E4` — and `design-system.md` §7.1
   * pins it there by name.
   *
   * `explanatory` is `textMuted`: a line that describes the *control* rather than reporting its
   * content, which §0's affordance table calls information. A chooser row's `Something you need
   * to do` is that. It is a real step down in dark (6.33:1 against the title's 15.92) and the
   * same value in light, where the palette deliberately collapses muted into secondary — the
   * founder's supplied `#978F84` is 2.7:1 and is decoration, not readable text (§5.1).
   */
  subtitleTone?: 'content' | 'explanatory';
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
  /**
   * Spoken after the name, on a pause (iOS). **Not a substitute for the name**: React Native
   * Web drops it, so anything a web user must hear belongs in `accessibilityLabel`.
   */
  accessibilityHint?: string;
  accessibilityActions?: { name: string; label: string }[];
  onAccessibilityAction?: (event: { nativeEvent: { actionName: string } }) => void;
  testID?: string;
}

export function Row({
  title,
  subtitle,
  subtitleTone = 'content',
  leading,
  trailing,
  onPress,
  accent,
  dimmed = false,
  struck = false,
  accessibilityLabel,
  accessibilityHint,
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
        <Text
          variant="subhead"
          color={subtitleTone === 'explanatory' ? 'textMuted' : 'textSecondary'}
          numberOfLines={1}
        >
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
      {...(accessibilityHint === undefined ? {} : { accessibilityHint })}
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
