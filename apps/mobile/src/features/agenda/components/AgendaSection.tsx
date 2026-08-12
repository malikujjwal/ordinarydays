import type { AgendaItem } from '@od/shared/types';
import { SectionHeader, useTheme } from '@od/ui';
import type { ReactNode } from 'react';
import { View } from 'react-native';
import type { AgendaSwipeAction } from '@/features/agenda/model/swipeActions';
import { CompletionTransition } from './CompletionTransition';
import { SwipeableRow } from './SwipeableRow';

export interface AgendaSectionProps {
  title: string;
  items: readonly AgendaItem[];
  footer?: ReactNode;
  testID: string;
  showTime?: boolean;
  onOpen: (item: AgendaItem) => void;
  onOpenReschedule?: (item: AgendaItem) => void;
  onToggleComplete?: (item: AgendaItem, checked: boolean) => void;
  onAction?: (item: AgendaItem, action: AgendaSwipeAction) => void;
  completionTransitionKeys?: ReadonlySet<string>;
  onCompletionTransitionFinished?: (transitionKey: string) => void;
}

export const agendaItemKey = (item: AgendaItem): string =>
  `${item.activityId}:${item.occurrenceDate ?? ''}`;

/** A section shell around the one shared AgendaRow implementation. */
export function AgendaSection({
  title,
  items,
  footer,
  testID,
  showTime = false,
  onOpen,
  onOpenReschedule,
  onToggleComplete,
  onAction,
  completionTransitionKeys,
  onCompletionTransitionFinished,
}: AgendaSectionProps) {
  const theme = useTheme();

  return (
    <View testID={testID} style={{ gap: theme.space[2] }}>
      <SectionHeader title={title} />
      {items.map((item) => {
        const key = agendaItemKey(item);
        const row = (
          <SwipeableRow
            key={key}
            item={item}
            showTime={showTime}
            onOpen={onOpen}
            {...(onOpenReschedule === undefined ? {} : { onOpenReschedule })}
            {...(onToggleComplete === undefined ? {} : { onToggleComplete })}
            {...(onAction === undefined ? {} : { onAction })}
          />
        );

        return completionTransitionKeys?.has(key) &&
          onCompletionTransitionFinished !== undefined ? (
          <CompletionTransition
            key={key}
            transitionKey={key}
            onFinished={onCompletionTransitionFinished}
          >
            {row}
          </CompletionTransition>
        ) : (
          row
        );
      })}
      {footer}
    </View>
  );
}
