import { Text, useTheme } from '@od/ui';
import { View } from 'react-native';
import { ChooserRow } from '@/features/compose/components/ChooserRow';
import { type ObjectChoice, objectChoices } from '@/features/compose/model/targets';

/**
 * The global object chooser — the first screen of every global Add
 * (`activities.md` §2.2, `interaction-contract.md` §1a.3).
 *
 * ```
 * What would you like to add?
 *
 * Task                        ›
 * Plan                        ›
 * List                        ›
 * ```
 *
 * ## What this component does not have, and why each absence is load-bearing
 *
 * - **No title field.** There is no path from the global `+` to a writable title before a
 *   target is chosen, so there is no text for anything to classify.
 * - **No recents, no reordering, no pre-selection.** `objectChoices` is frozen and rendered
 *   in order. Explicit intent costs the same one tap every time — the moment it costs less
 *   for the common case, the uncommon case starts being chosen by accident.
 * - **No default row and no "Skip".** Backing out writes nothing; there is no state in which
 *   the app proceeds with a target the user did not name.
 *
 * It takes no props but `onChoose`. It cannot be handed a suggestion because there is no
 * prop through which one could arrive.
 */
export interface ObjectChooserProps {
  onChoose: (choice: ObjectChoice) => void;
}

export function ObjectChooser({ onChoose }: ObjectChooserProps) {
  const theme = useTheme();

  return (
    <View testID="object-chooser" style={{ gap: theme.space[5] }}>
      <Text variant="title" color="textDisplay" accessibilityRole="header">
        What would you like to add?
      </Text>

      <View>
        {objectChoices.map((choice) => (
          <ChooserRow
            key={choice.value}
            label={choice.label}
            subtitle={choice.subtitle}
            onPress={() => onChoose(choice.value)}
            testID={`object-choice-${choice.value}`}
          />
        ))}
      </View>
    </View>
  );
}
