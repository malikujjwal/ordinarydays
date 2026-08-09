import { Image, View } from 'react-native';
import { avatarTint } from '../theme/colors';
import { useTheme } from '../theme/index';
import { Text } from './Text';

/**
 * A person, as a disc (`design-system.md` §6, §7.4).
 *
 * The fallback is **tinted initials**, not a grey silhouette: two letters on a disc filled
 * from the `*Surface` family, with a **stable** per-person tint so the same person is the
 * same colour on every screen and every launch. A random tint would make the disc
 * unrecognisable, which is the only job it has.
 */
export interface AvatarProps {
  displayName: string;
  imageUrl?: string;
  size?: 'sm' | 'md' | 'lg';
  testID?: string;
}

const sizes = { sm: 24, md: 28, lg: 48 } as const;

/** First letters of the first two words — `Alex Rivera` → `AR`, `Mika` → `M`. */
export function initialsOf(displayName: string): string {
  return displayName
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word.charAt(0).toUpperCase())
    .join('');
}

export function Avatar({ displayName, imageUrl, size = 'md', testID }: AvatarProps) {
  const theme = useTheme();
  const px = sizes[size];
  const tint = avatarTint(displayName, theme.scheme);

  return (
    <View
      accessible
      accessibilityLabel={displayName}
      testID={testID}
      style={{
        width: px,
        height: px,
        borderRadius: theme.radius.pill,
        backgroundColor: tint.background,
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
      }}
    >
      {imageUrl === undefined ? (
        <Text variant="footnoteStrong" color="textPrimary">
          {initialsOf(displayName)}
        </Text>
      ) : (
        <Image
          source={{ uri: imageUrl }}
          style={{ width: px, height: px }}
          accessibilityIgnoresInvertColors
        />
      )}
    </View>
  );
}

/**
 * Up to `max` avatars overlapped by 6 pt, then a `+n` disc.
 *
 * **Non-interactive on rows.** The people are named in the row's accessible label; a stack of
 * individually focusable discs would make every row a keyboard trap of four stops.
 */
export interface AvatarStackProps {
  people: { displayName: string; imageUrl?: string }[];
  max?: number;
  size?: 'sm' | 'md' | 'lg';
  testID?: string;
}

export function AvatarStack({ people, max = 4, size = 'sm', testID }: AvatarStackProps) {
  const theme = useTheme();
  const shown = people.slice(0, max);
  const extra = people.length - shown.length;
  const px = sizes[size];

  return (
    <View
      accessible
      accessibilityLabel={
        people.length === 0
          ? 'No one'
          : people.map((person) => person.displayName).join(', ')
      }
      testID={testID}
      style={{ flexDirection: 'row', alignItems: 'center' }}
    >
      {shown.map((person, index) => (
        <View
          key={person.displayName}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={{
            marginLeft: index === 0 ? 0 : -6,
            borderRadius: theme.radius.pill,
            borderWidth: 1.5,
            borderColor: theme.colors.surface,
          }}
        >
          <Avatar
            displayName={person.displayName}
            {...(person.imageUrl === undefined ? {} : { imageUrl: person.imageUrl })}
            size={size}
          />
        </View>
      ))}
      {extra > 0 ? (
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={{
            marginLeft: -6,
            width: px,
            height: px,
            borderRadius: theme.radius.pill,
            backgroundColor: theme.colors.surfaceSunken,
            borderWidth: 1.5,
            borderColor: theme.colors.surface,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text variant="caption" color="textSecondary">
            {`+${extra}`}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
