import { type ListTemplateChoice, listTemplateChoices } from '@od/shared/lists';
import { Text, useTheme } from '@od/ui';
import { View } from 'react-native';
import { ListStyleCard } from '@/features/compose/components/ListStyleCard';

/**
 * The seven List styles, inline on global Add.
 *
 * Same catalogue, order and copy as the Lists-index sheet. This control **selects**; it
 * does not navigate, and it never writes a default title over the words already entered.
 */
export interface ListStyleChooserProps {
  selectedKey: string | undefined;
  onChoose: (choice: ListTemplateChoice) => void;
}

export function ListStyleChooser({ selectedKey, onChoose }: ListStyleChooserProps) {
  const theme = useTheme();
  const choices = listTemplateChoices();
  const blank = choices[0];
  const typedChoices = choices.slice(1);

  return (
    <View testID="list-style-chooser" style={{ gap: theme.space[4] }}>
      <Text variant="subhead" color="textSecondary" accessibilityRole="header">
        List style
      </Text>
      <Text variant="footnote" color="textSecondary">
        Your text becomes the list name. The style controls how its items work.
      </Text>
      {blank === undefined ? null : (
        <View testID="list-style-leading">
          <ListStyleCard
            choice={blank}
            leading
            selected={selectedKey === blank.templateKey}
            onPress={() => onChoose(blank)}
          />
        </View>
      )}
      <View
        testID="list-style-grid"
        style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[3] }}
      >
        {typedChoices.map((choice) => (
          <View key={choice.templateKey} style={{ flexBasis: '47%', flexGrow: 1 }}>
            <ListStyleCard
              choice={choice}
              selected={selectedKey === choice.templateKey}
              onPress={() => onChoose(choice)}
            />
          </View>
        ))}
      </View>
    </View>
  );
}
