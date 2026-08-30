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
  /** `dashed` is the small contextual-create affordance from §7.2b. */
  treatment?: 'filled' | 'dashed' | 'collection';
  testID?: string;
}

export function IconTile({
  icon: Icon,
  tint,
  size = 44,
  treatment = 'filled',
  testID,
}: IconTileProps) {
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
        ...(treatment === 'dashed'
          ? {
              borderWidth: 1,
              borderStyle: 'dashed' as const,
              borderColor: theme.colors.borderStrong,
            }
          : {
              backgroundColor:
                treatment === 'collection'
                  ? theme.colors.collectionIconSurface
                  : accent.surface,
            }),
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Icon
        size={Math.round(size * 0.55)}
        color={
          treatment === 'dashed'
            ? theme.colors.textAction
            : treatment === 'collection'
              ? theme.colors.textPrimary
              : accent.accent
        }
      />
    </View>
  );
}
