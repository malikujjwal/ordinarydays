import { Chip } from '@od/ui';
import {
  formatOverdueAccessibilityLabel,
  formatOverdueAge,
  formatOverdueChip,
} from '@/features/agenda/model/formatOverdueChip';

export interface OverdueChipProps {
  overdueFromDate: string;
  today: string;
  onPress?: () => void;
  /** Today's compact untimed rows use age at the trailing edge, with the due date in-row. */
  age?: boolean;
}

/** A quiet, date-first route into rescheduling a rolled-forward task. */
export function OverdueChip({
  overdueFromDate,
  today,
  onPress,
  age = false,
}: OverdueChipProps) {
  return (
    <Chip
      label={
        age
          ? formatOverdueAge(overdueFromDate, today)
          : formatOverdueChip(overdueFromDate, today)
      }
      accessibilityLabel={formatOverdueAccessibilityLabel(overdueFromDate)}
      tone="warning"
      {...(onPress === undefined ? {} : { onPress })}
      testID="agenda-badge-overdue"
    />
  );
}
