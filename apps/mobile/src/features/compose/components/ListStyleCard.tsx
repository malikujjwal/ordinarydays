import type { ListTemplateChoice } from '@od/shared/lists';
import { IconTile, Text, Touchable, templateIcon, useTheme } from '@od/ui';
import { View } from 'react-native';

export interface ListStyleCardProps {
  choice: ListTemplateChoice;
  leading?: boolean;
  selected: boolean;
  onPress: () => void;
}

/** One selectable List style on global Add. Navigation chevrons belong to NewListSheet. */
export function ListStyleCard({
  choice,
  leading = false,
  selected,
  onPress,
}: ListStyleCardProps) {
  const theme = useTheme();
  const icon = templateIcon(choice.icon);
  const label = choice.templateKey === 'blank' ? 'Blank list' : choice.chooserLabel;

  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={`${label}. ${choice.summary}`}
      accessibilityState={{ selected }}
      aria-pressed={selected}
      onPress={onPress}
      testID={`list-style-${choice.templateKey}`}
      style={{
        ...theme.elevation('e1'),
        padding: theme.space[4],
        borderRadius: theme.radius.lg,
        backgroundColor: selected
          ? theme.colors.accentSurface
          : theme.colors.surfaceRaised,
        borderWidth: 1,
        borderColor: selected ? theme.colors.accentBorder : 'transparent',
      }}
    >
      <View
        style={{
          flexDirection: leading ? 'row' : 'column',
          alignItems: leading ? 'center' : 'stretch',
          gap: theme.space[3],
          ...(leading ? { minHeight: theme.layout.rowMinHeight } : {}),
        }}
      >
        <IconTile icon={icon} tint="custom" />
        <View style={{ flex: 1, minWidth: 0, gap: theme.space[2] }}>
          <Text variant="bodyStrong" numberOfLines={2}>
            {label}
          </Text>
          <Text variant="footnote" color="textSecondary">
            {choice.summary}
          </Text>
        </View>
      </View>
    </Touchable>
  );
}
