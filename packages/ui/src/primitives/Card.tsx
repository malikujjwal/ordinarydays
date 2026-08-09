import { View } from 'react-native';
import type { ElevationToken } from '../theme/elevation';
import { upNextShadow } from '../theme/elevation';
import { useTheme } from '../theme/index';
import type { SpaceToken } from '../theme/tokens';
import { Touchable } from './Touchable';

/**
 * A raised surface (`design-system.md` §4.1, §4.2, §6).
 *
 * Only cards, sheets and the hero surface are rounded — rows on Today are not cards and have
 * no radius. The elevation comes from `theme.elevation()`, which returns a shadow in light
 * and a lighter surface plus a hairline in dark, so this component **never branches on the
 * scheme**.
 */
export interface CardProps {
  children: React.ReactNode;
  elevation?: Extract<ElevationToken, 'e1' | 'e2' | 'e3'>;
  radius?: 'lg' | 'xl';
  padding?: SpaceToken;
  onPress?: () => void;
  /** The UP NEXT card's mulberry-tinted shadow. The one surface that gets it. */
  hero?: boolean;
  accessibilityLabel?: string;
  testID?: string;
}

export function Card({
  children,
  elevation = 'e2',
  radius = 'lg',
  padding = 6,
  onPress,
  hero = false,
  accessibilityLabel,
  testID,
}: CardProps) {
  const theme = useTheme();

  const style = [
    {
      backgroundColor: hero ? theme.colors.accentSurface : theme.colors.surfaceRaised,
      borderRadius: theme.radius[radius],
      padding: theme.space[padding],
    },
    theme.elevation(elevation),
    hero && theme.scheme === 'light' ? ({ boxShadow: upNextShadow } as object) : null,
    hero ? { borderWidth: 1, borderColor: theme.colors.accentDeep } : null,
  ];

  if (onPress === undefined) {
    return (
      <View style={style} testID={testID}>
        {children}
      </View>
    );
  }

  // The whole card is one tap target (U1) — the RSVP pill, when present, is a separate one.
  return (
    <Touchable
      accessibilityRole="button"
      {...(accessibilityLabel === undefined ? {} : { accessibilityLabel })}
      onPress={onPress}
      testID={testID}
      style={style}
    >
      {children}
    </Touchable>
  );
}
