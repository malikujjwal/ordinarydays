import { View } from 'react-native';
import type { IconProps } from '../icons/index';
import type { ActivityTypeName } from '../theme/colors';
import { useTheme } from '../theme/index';

/**
 * The icon squircle on plan and list cards (`design-system.md` §5.2, §6).
 *
 * **Non-interactive and hidden from assistive tech.** Its meaning is already in the row or
 * card's label — announcing "diamond" beside "Philadelphia Food Festival" adds noise, not
 * information (`interaction-contract.md` §6.2).
 */
export interface IconTileProps {
  icon: (props: IconProps) => React.ReactElement;
  tint: ActivityTypeName;
  size?: number;
  testID?: string;
}

export function IconTile({ icon: Icon, tint, size = 44, testID }: IconTileProps) {
  const theme = useTheme();
  const accent = theme.typeAccent(tint);

  return (
    <View
      /**
       * `aria-hidden` as well as the two platform props: `accessibilityElementsHidden` is
       * iOS-only and `importantForAccessibility` is Android-only, so on web neither reaches
       * the DOM and the tile stays in the accessibility tree announcing a decorative shape.
       */
      aria-hidden
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      testID={testID}
      style={{
        width: size,
        height: size,
        borderRadius: theme.radius.md,
        backgroundColor: accent.surface,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Icon size={Math.round(size * 0.55)} color={accent.accent} />
    </View>
  );
}
