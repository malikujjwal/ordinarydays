import type { PlanType } from '@od/shared/types';
import { Text, useTheme } from '@od/ui';
import { View } from 'react-native';
import { ChooserRow } from '@/features/compose/components/ChooserRow';
import { planKindChoices } from '@/features/compose/model/targets';

/**
 * The second required chooser, shown only after `Plan`
 * (`activities.md` §2.2, `interaction-contract.md` §1a.3).
 *
 * ```
 * What kind of plan?
 *
 * General                     ›
 * Meal                        ›
 * Watch                       ›
 * Event                       ›
 * ```
 *
 * **`General` is a real, visible choice and is never the value used when nothing was
 * selected.** That is the single most important line in this file: `custom` is what General
 * stores, and the only way to reach `custom` is to tap the first row. There is no
 * `defaultPlanKind`, and the store leaves `target` undefined between `Plan` and this screen
 * precisely so that "no kind chosen yet" is representable rather than collapsing into
 * General.
 *
 * > **New copy.** `activities.md` §2.2 draws the object chooser's heading but names none for
 * > this step. `What kind of plan?` is added to that section in this PR and is flagged in the
 * > PR description for the founder to confirm or replace.
 */
export interface PlanKindChooserProps {
  onChoose: (type: PlanType) => void;
}

export function PlanKindChooser({ onChoose }: PlanKindChooserProps) {
  const theme = useTheme();

  return (
    <View testID="plan-kind-chooser" style={{ gap: theme.space[5] }}>
      <Text variant="title" color="textDisplay" accessibilityRole="header">
        What kind of plan?
      </Text>

      <View>
        {planKindChoices.map((choice) => (
          <ChooserRow
            key={choice.value}
            label={choice.label}
            subtitle={choice.subtitle}
            onPress={() => onChoose(choice.value)}
            testID={`plan-kind-${choice.value}`}
          />
        ))}
      </View>
    </View>
  );
}
