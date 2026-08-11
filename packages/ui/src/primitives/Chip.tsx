import { Platform, View } from 'react-native';
import type { IconProps } from '../icons/index';
import { useTheme } from '../theme/index';
import { Text, type TextColor } from './Text';
import { Touchable } from './Touchable';

/**
 * A small label or filter (`design-system.md` §6).
 *
 * Also carries provenance — `From screenshot`, `From link` — in `neutral` on a
 * `surfaceSunken` fill. That is the visible half of "capture never owns intent": the user can
 * always see where a field came from.
 */
export type ChipTone = 'neutral' | 'accent' | 'warning' | 'danger' | 'success';

export interface ChipProps {
  label: string;
  icon?: (props: IconProps) => React.ReactElement;
  tone?: ChipTone;
  onPress?: () => void;
  selected?: boolean;
  disabled?: boolean;
  testID?: string;
}

export function Chip({
  label,
  icon: Icon,
  tone = 'neutral',
  onPress,
  selected = false,
  disabled = false,
  testID,
}: ChipProps) {
  const theme = useTheme();

  const tones: Record<ChipTone, { bg: string; fg: TextColor }> = {
    neutral: { bg: theme.colors.surfaceSunken, fg: 'textSecondary' },
    accent: { bg: theme.colors.accentSurface, fg: 'accent' },
    warning: { bg: theme.colors.warningSurface, fg: 'warning' },
    success: { bg: theme.colors.successSurface, fg: 'success' },
    danger: { bg: theme.colors.surfaceSunken, fg: 'danger' },
  };

  const palette = selected ? tones.accent : tones[tone];

  const body = (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space[2],
        paddingHorizontal: theme.space[4],
        paddingVertical: theme.space[2],
        borderRadius: theme.radius.pill,
        backgroundColor: palette.bg,
        opacity: disabled ? 0.45 : 1,
      }}
    >
      {Icon === undefined ? null : (
        <Icon
          size={14}
          color={theme.colors[palette.fg === 'accent' ? 'accent' : 'textSecondary']}
        />
      )}
      <Text variant="footnote" color={palette.fg} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );

  if (onPress === undefined) {
    return (
      <View
        testID={testID}
        {...(Platform.OS === 'web'
          ? {}
          : { accessible: true, accessibilityLabel: label })}
      >
        {body}
      </View>
    );
  }

  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected, disabled }}
      /**
       * The web half of the same statement. React Native Web drops
       * `accessibilityState.selected` on `role="button"` — it maps it only for roles where
       * `aria-selected` is legal — so a selected filter chip announced nothing and its
       * selection was carried by the accent fill alone. Colour is never the only carrier of
       * meaning (`design-system.md` §5.1), and `aria-pressed` is the attribute ARIA gives a
       * toggle button. Found in P1-22 when `DatePicker`'s chips had no way to say which date
       * was chosen.
       */
      aria-pressed={selected}
      disabled={disabled}
      onPress={onPress}
      testID={testID}
      style={{ alignSelf: 'flex-start' }}
    >
      {body}
    </Touchable>
  );
}
