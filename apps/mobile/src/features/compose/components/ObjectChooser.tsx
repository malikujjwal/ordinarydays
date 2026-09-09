import { Text, useTheme } from '@od/ui';
import { View } from 'react-native';
import { SelectableChoice } from '@/features/compose/components/SelectableChoice';
import { type ObjectChoice, objectChoices } from '@/features/compose/model/targets';

/**
 * The global object chooser — Task / Plan / Add list on the same sheet as the title
 * (`activities.md` §2.2, `interaction-contract.md` §1a.3).
 *
 * The title field lives on the screen, not here. These rows never classify that text:
 * nothing is selected, recommended or inferred, and tapping a row only names the object.
 * They stay visible while disabled so Task / Plan / Add list can be seen before a title exists.
 */
export interface ObjectChooserProps {
  selected: ObjectChoice | undefined;
  onChoose: (choice: ObjectChoice) => void;
  disabled?: boolean;
}

export function ObjectChooser({
  selected,
  onChoose,
  disabled = false,
}: ObjectChooserProps) {
  const theme = useTheme();

  return (
    <View testID="object-chooser" style={{ gap: theme.space[4] }}>
      <Text variant="subhead" color="textSecondary">
        Create as
      </Text>
      <View style={{ gap: theme.space[3] }}>
        {objectChoices.map((choice) => (
          <SelectableChoice
            key={choice.value}
            label={choice.label}
            subtitle={choice.subtitle}
            selected={selected === choice.value}
            disabled={disabled}
            onPress={() => onChoose(choice.value)}
            testID={`object-choice-${choice.value}`}
          />
        ))}
      </View>
    </View>
  );
}
