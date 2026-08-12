import type { AgendaItem } from '@od/shared/types';
import { SectionHeader, useTheme } from '@od/ui';
import type { ReactNode } from 'react';
import { View } from 'react-native';
import type { AgendaSwipeAction } from '@/features/agenda/model/swipeActions';
import { SwipeableRow } from './SwipeableRow';

export interface AgendaSectionProps {
  title: string;
  items: readonly AgendaItem[];
  footer?: ReactNode;
  testID: string;
  showTime?: boolean;
  onOpen: (item: AgendaItem) => void;
  onToggleComplete?: (item: AgendaItem, checked: boolean) => void;
  onAction?: (item: AgendaItem, action: AgendaSwipeAction) => void;
}

/** A section shell around the one shared AgendaRow implementation. */
export function AgendaSection({
  title,
  items,
  footer,
  testID,
  showTime = false,
  onOpen,
  onToggleComplete,
  onAction,
}: AgendaSectionProps) {
  const theme = useTheme();

  return (
    <View testID={testID} style={{ gap: theme.space[2] }}>
      <SectionHeader title={title} />
      {items.map((item) => (
        <SwipeableRow
          key={`${item.activityId}:${item.occurrenceDate ?? ''}`}
          item={item}
          showTime={showTime}
          onOpen={onOpen}
          {...(onToggleComplete === undefined ? {} : { onToggleComplete })}
          {...(onAction === undefined ? {} : { onAction })}
        />
      ))}
      {footer}
    </View>
  );
}
