import { Chip, SectionHeader, Touchable, useTheme } from '@od/ui';
import { View } from 'react-native';

/**
 * The one `Add to this plan` row of named chips (§2.1 amended): how an empty section is
 * discovered without an empty heading. `People · coming later` renders as its own row above,
 * not here — the pre-build treatment is unchanged. Updates has no chip by design: its
 * visible section always carries its own composer (see `AddToPlanChips`).
 */
export interface AddToPlanRowProps {
  chips: { prepTask: boolean; list: boolean };
  onAddPrepTask?: () => void;
  onAddList?: () => void;
}

export function AddToPlanRow({ chips, onAddPrepTask, onAddList }: AddToPlanRowProps) {
  const theme = useTheme();
  const entries = [
    chips.prepTask && onAddPrepTask !== undefined
      ? { label: 'Prep task', onPress: onAddPrepTask }
      : undefined,
    chips.list && onAddList !== undefined
      ? { label: 'List', onPress: onAddList }
      : undefined,
  ].filter(
    (entry): entry is { label: string; onPress: () => void } => entry !== undefined,
  );
  if (entries.length === 0) return null;

  return (
    <View style={{ gap: theme.space[3] }} testID="add-to-plan">
      <SectionHeader title="Add to this plan" />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[2] }}>
        {entries.map((entry) => (
          <Touchable
            key={entry.label}
            accessibilityRole="button"
            accessibilityLabel={`Add ${entry.label.toLowerCase()} to this plan`}
            onPress={entry.onPress}
            testID={`add-to-plan-${entry.label.toLowerCase().replaceAll(' ', '-')}`}
          >
            <Chip label={entry.label} />
          </Touchable>
        ))}
      </View>
    </View>
  );
}
