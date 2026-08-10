import type { PlanType } from '@od/shared/types';
import { Button, Sheet, Text, useTheme } from '@od/ui';
import { View } from 'react-native';
import { planKindChoices } from '@/lib/planKinds';

/**
 * The Plan-kind chooser, reached from `⋯` (`activities.md` §6.3 rules 1 and 2).
 *
 * Serves both conversions that need a Plan kind: `Change to Plan` on a Task and
 * `Change Plan kind` on a Plan. **`General` is not assumed** — rule 2 says the user must
 * choose one — so nothing is pre-selected here any more than in the create chooser, and the
 * five appear in their fixed documented order.
 *
 * The current kind is marked rather than removed from the list. Removing it would silently
 * renumber the choices depending on what the plan already is, and re-choosing it is a no-op
 * the mapping already handles (P1-17), not an error to design around.
 *
 * **Nothing is written here.** Choosing a kind produces the confirmation, or applies the
 * change when it is additive — `Save changes` is the write, per rule 2.
 */
export interface ChangeKindSheetProps {
  open: boolean;
  onClose: () => void;
  onChoose: (type: PlanType) => void;
  /** The plan's current kind, marked as such. Absent when converting a Task. */
  current?: PlanType;
  /** `Change Plan kind` or `Change to Plan`, so the sheet names what it is doing. */
  title: string;
}

export function ChangeKindSheet({
  open,
  onClose,
  onChoose,
  current,
  title,
}: ChangeKindSheetProps) {
  const theme = useTheme();

  return (
    <Sheet open={open} onClose={onClose} title={title} testID="change-kind-sheet">
      <View style={{ gap: theme.space[3] }}>
        {planKindChoices.map((choice) => (
          <Button
            key={choice.value}
            label={choice.label}
            variant="secondary"
            fullWidth
            onPress={() => onChoose(choice.value)}
            testID={`change-kind-${choice.value}`}
          />
        ))}
      </View>

      {current === undefined ? null : (
        <Text variant="footnote" color="textSecondary" testID="change-kind-current">
          {`This plan is a ${planKindChoices.find((c) => c.value === current)?.label ?? ''} now.`}
        </Text>
      )}
    </Sheet>
  );
}
