import { View } from 'react-native';
import type { CollectionSurfaceTone } from '../theme/colors';
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
interface CardSurfaceProps {
  children: React.ReactNode;
  elevation?: Extract<ElevationToken, 'e1' | 'e2' | 'e3'>;
  radius?: 'lg' | 'xl';
  padding?: SpaceToken;
  /**
   * Overrides the bottom padding alone — added 2026-08-17.
   *
   * A card whose last child is a row of 44 pt hit targets already carries the control's own
   * slack below its text, so uniform padding renders visibly bottom-heavy. The target keeps its
   * 44 pt (`interaction-contract.md` §2); the card stops paying for it twice.
   */
  paddingBottom?: SpaceToken;
  /** The UP NEXT card's mulberry-tinted shadow. The one surface that gets it. */
  hero?: boolean;
  /** Shared collection fill; callers choose a semantic tone, never a raw colour. */
  surfaceTone?: CollectionSurfaceTone;
  accessibilityLabel?: string;
  testID?: string;
}

type CardInteractionProps =
  | {
      onPress?: undefined;
      onLongPress?: never;
      delayLongPress?: never;
    }
  | {
      onPress: () => void;
      onLongPress?: undefined;
      delayLongPress?: never;
    }
  | {
      onPress: () => void;
      /** Secondary gesture; the caller must expose the same actions accessibly. */
      onLongPress: () => void;
      /** Recognition delay for the shared Pressable path. */
      delayLongPress?: number;
    };

/** A Card is either a passive surface or one valid interactive target. */
export type CardProps = CardSurfaceProps & CardInteractionProps;

export function Card({
  children,
  elevation = 'e2',
  radius = 'lg',
  padding = 6,
  paddingBottom,
  onPress,
  onLongPress,
  delayLongPress,
  hero = false,
  surfaceTone = 'neutral',
  accessibilityLabel,
  testID,
}: CardProps) {
  const theme = useTheme();

  const style = [
    {
      backgroundColor: theme.collectionSurface('neutral'),
      borderRadius: theme.radius[radius],
      padding: theme.space[padding],
      ...(paddingBottom === undefined
        ? {}
        : { paddingBottom: theme.space[paddingBottom] }),
    },
    theme.elevation(elevation),
    surfaceTone === 'neutral'
      ? null
      : { backgroundColor: theme.collectionSurface(surfaceTone) },
    hero ? { backgroundColor: theme.colors.upNextSurface } : null,
    hero && theme.scheme === 'light' ? ({ boxShadow: upNextShadow } as object) : null,
    /**
     * **A left edge, not a rim** — corrected 2026-08-17 against `design-system.md` §7.1, which
     * specifies a tinted fill and 3 pt accentDeep left border, and which the
     * founder's frames draw the same way.
     *
     * It was built as a 1 px `accentBorder` box on all four sides. Outlined like that the card
     * read as a container competing with the rows beneath it rather than as the one hero
     * surface; the left edge marks it without boxing it. `accentDeep` is a graphic here, not
     * text, and it is the same token §7.1 names.
     */
    hero ? { borderLeftWidth: 3, borderLeftColor: theme.colors.accentDeep } : null,
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
      {...(onLongPress === undefined ? {} : { onLongPress })}
      {...(delayLongPress === undefined ? {} : { delayLongPress })}
      testID={testID}
      style={style}
    >
      {children}
    </Touchable>
  );
}
