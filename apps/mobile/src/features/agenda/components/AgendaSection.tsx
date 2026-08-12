import type { AgendaItem } from '@od/shared/types';
import { SectionHeader, useTheme } from '@od/ui';
import { Fragment, type ReactNode } from 'react';
import { View } from 'react-native';
import type { AgendaSwipeAction } from '@/features/agenda/model/swipeActions';
import { CompletionTransition } from './CompletionTransition';
import { SwipeableRow } from './SwipeableRow';

export interface AgendaSectionProps {
  title: string;
  items: readonly AgendaItem[];
  footer?: ReactNode;
  interstitial?: ReactNode;
  interstitialAfterIndex?: number;
  testID: string;
  showTime?: boolean;
  today?: string;
  onOpen: (item: AgendaItem) => void;
  onOpenReschedule?: (item: AgendaItem) => void;
  onOpenOverdue?: (item: AgendaItem) => void;
  onToggleComplete?: (item: AgendaItem, checked: boolean) => void;
  onOpenResolution?: (item: AgendaItem) => void;
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
  interstitial,
  interstitialAfterIndex,
  testID,
  showTime = false,
  today,
  onOpen,
  onOpenReschedule,
  onOpenOverdue,
  onToggleComplete,
  onOpenResolution,
  onAction,
  completionTransitionKeys,
  onCompletionTransitionFinished,
}: AgendaSectionProps) {
  const theme = useTheme();

  return (
    <View testID={testID} style={{ gap: theme.space[2] }}>
      <SectionHeader title={title} />
      {items.map((item, index) => {
        const key = agendaItemKey(item);
        const row = (
          <SwipeableRow
            item={item}
            showTime={showTime}
            {...(today === undefined ? {} : { today })}
            onOpen={onOpen}
            {...(onOpenReschedule === undefined ? {} : { onOpenReschedule })}
            {...(onOpenOverdue === undefined ? {} : { onOpenOverdue })}
            {...(onToggleComplete === undefined ? {} : { onToggleComplete })}
            {...(onOpenResolution === undefined ? {} : { onOpenResolution })}
            {...(onAction === undefined ? {} : { onAction })}
          />
        );

        return (
          <Fragment key={key}>
            {completionTransitionKeys?.has(key) &&
            onCompletionTransitionFinished !== undefined ? (
              <CompletionTransition
                transitionKey={key}
                onFinished={onCompletionTransitionFinished}
              >
                {row}
              </CompletionTransition>
            ) : (
              row
            )}
            {interstitialAfterIndex === index ? interstitial : null}
          </Fragment>
        );
      })}
      {footer}
    </View>
  );
}
