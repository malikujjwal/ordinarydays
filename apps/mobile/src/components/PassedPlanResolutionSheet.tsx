import type { ActivityOutcome, ActivityType } from '@od/shared/types';
import { Button, Sheet, Text, useTheme } from '@od/ui';
import { View } from 'react-native';
import { passedPlanResolution } from '@/lib/passedPlanResolution';

export interface PassedPlanResolutionSheetProps {
  open: boolean;
  type: ActivityType;
  title: string;
  busy?: boolean;
  onClose: () => void;
  onResolve: (outcome: ActivityOutcome) => void;
}

/** The one neutral two-outcome chooser used by Today and activity detail. */
export function PassedPlanResolutionSheet({
  open,
  type,
  title,
  busy = false,
  onClose,
  onResolve,
}: PassedPlanResolutionSheetProps) {
  const theme = useTheme();
  const resolution = passedPlanResolution(type);

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={resolution.prompt}
      testID="passed-plan-resolution-sheet"
    >
      <Text variant="subhead" color="textSecondary">
        {title}
      </Text>
      <View style={{ gap: theme.space[3] }}>
        <Button
          label={resolution.positive.label}
          variant="secondary"
          fullWidth
          loading={busy}
          onPress={() => onResolve(resolution.positive.outcome)}
          testID="passed-plan-positive"
        />
        <Button
          label={resolution.negative.label}
          variant="secondary"
          fullWidth
          disabled={busy}
          onPress={() => onResolve(resolution.negative.outcome)}
          testID="passed-plan-negative"
        />
      </View>
    </Sheet>
  );
}
