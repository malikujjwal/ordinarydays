import { Plus, SectionHeader, Text, Touchable, useTheme } from '@od/ui';
import { View } from 'react-native';

/**
 * The one `Add to this plan` / `Add to this task` row of named chips (§2.1 amended): how an
 * empty section is discovered without an empty heading. `People · coming later` renders as
 * its own row above, not here — the pre-build treatment is unchanged. Updates has no chip
 * by design: its visible section always carries its own composer (see `AddToPlanChips`).
 *
 * Type-fact chips (`Recipe`, `Link`, …) sit in the same row. A Task uses this component
 * with `label="Add to this task"` and only `Link` — never a Task-only primitive.
 */
export interface AddToPlanChip {
  readonly key: string;
  readonly label: string;
  readonly onPress: () => void;
}

export interface AddToPlanRowProps {
  chips: ReadonlyArray<AddToPlanChip>;
  /** Default `Add to this plan`. Task detail passes `Add to this task`. */
  label?: string;
  /** `plan` or `task` — used in each chip's accessibility name. */
  objectKind?: 'plan' | 'task';
}

export function AddToPlanRow({
  chips,
  label = 'Add to this plan',
  objectKind = 'plan',
}: AddToPlanRowProps) {
  const theme = useTheme();
  if (chips.length === 0) return null;

  return (
    <View style={{ gap: theme.space[3] }} testID="add-to-plan">
      <SectionHeader title={label} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[2] }}>
        {chips.map((entry) => (
          <Touchable
            key={entry.key}
            accessibilityRole="button"
            accessibilityLabel={`Add ${entry.label.toLowerCase()} to this ${objectKind}`}
            onPress={entry.onPress}
            testID={`add-to-plan-${entry.label.toLowerCase().replaceAll(' ', '-')}`}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: theme.space[3],
              maxWidth: '100%',
              minHeight: theme.layout.hitTarget,
              paddingHorizontal: theme.space[4],
              paddingVertical: theme.space[3],
              borderWidth: 1,
              borderColor: theme.colors.borderStrong,
              borderRadius: theme.radius.md,
            }}
          >
            <Plus size={20} color={theme.colors.textAction} />
            <View style={{ flexShrink: 1 }}>
              <Text variant="body" color="textAction">
                {entry.label}
              </Text>
            </View>
          </Touchable>
        ))}
      </View>
    </View>
  );
}
