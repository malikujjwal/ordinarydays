import type { ListTemplateChoice } from '@od/shared/lists';
import { Card, ChevronRight, IconTile, Text, templateIcons, useTheme } from '@od/ui';
import { View } from 'react-native';

export interface ListTypeCardProps {
  choice: ListTemplateChoice;
  leading?: boolean;
  onPress: () => void;
}

/** One actionable catalogue choice; it communicates navigation, never selection. */
export function ListTypeCard({ choice, leading = false, onPress }: ListTypeCardProps) {
  const theme = useTheme();
  const icon = templateIcons[choice.icon] ?? templateIcons.list;
  if (icon === undefined)
    throw new Error('The template icon registry has no list fallback.');
  const label = choice.templateKey === 'blank' ? 'Blank list' : choice.chooserLabel;

  return (
    <Card
      elevation="e1"
      padding={4}
      onPress={onPress}
      accessibilityLabel={`${label}. ${choice.summary}`}
      testID={`list-style-${choice.templateKey}`}
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
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: theme.space[2],
            }}
          >
            <Text variant="bodyStrong" numberOfLines={2}>
              {label}
            </Text>
            <View
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            >
              <ChevronRight size={18} color={theme.colors.textSecondary} />
            </View>
          </View>
          <Text variant="footnote" color="textSecondary">
            {choice.summary}
          </Text>
        </View>
      </View>
    </Card>
  );
}
