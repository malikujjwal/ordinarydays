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
  /** The section header's trailing control — EARLIER TODAY's `n done ⌃` collapse (P2-44). */
  headerAction?: ReactNode;
  /**
   * A plain figure on the header's trailing edge — ANYTIME's row count (founder, 2026-08-17).
   *
   * Deliberately **not** `n of m done`: the phase amendment rejected a second completion figure
   * because it dilutes the day bar, and the founder's instruction was "just a count ... no need
   * to track how many are complete". A count is not a progress figure, so the guard holds.
   */
  headerCount?: number;
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
  headerAction,
  headerCount,
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
      <SectionHeader
        title={title}
        {...(headerCount === undefined ? {} : { count: headerCount })}
        {...(headerAction === undefined ? {} : { action: headerAction })}
      />
      {items.map((item, index) => {
        const key = agendaItemKey(item);
        /**
         * The timeline connector's ends (`design-system.md` §7.1, P2-44). The section is the
         * only thing that knows which row is first and which is last, so it decides, and the
         * row only draws. Nothing runs above the first marker or below the last.
         */
        const row = (
          <SwipeableRow
            item={item}
            showTime={showTime}
            connectorBelow={index < items.length - 1}
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
