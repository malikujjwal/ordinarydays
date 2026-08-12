import { Chip } from '@od/ui';
import {
  formatOverdueAccessibilityLabel,
  formatOverdueChip,
} from '@/features/agenda/model/formatOverdueChip';

export interface OverdueChipProps {
  overdueFromDate: string;
  today: string;
  onPress?: () => void;
}

/** A quiet, date-first route into rescheduling a rolled-forward task. */
export function OverdueChip({ overdueFromDate, today, onPress }: OverdueChipProps) {
  return (
    <Chip
      label={formatOverdueChip(overdueFromDate, today)}
      accessibilityLabel={formatOverdueAccessibilityLabel(overdueFromDate)}
      tone="warning"
      {...(onPress === undefined ? {} : { onPress })}
      testID="agenda-badge-overdue"
    />
  );
}
