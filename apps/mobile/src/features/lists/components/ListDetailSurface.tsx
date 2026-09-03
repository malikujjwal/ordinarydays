import type { List, ListItemView } from '@od/shared/types';
import { EmptyState, ScreenShell, Skeleton, Text, useTheme } from '@od/ui';
import type { ReactNode } from 'react';
import { useCallback } from 'react';
import { View } from 'react-native';
import type { ListItemRow as ListItemRowData } from '@/lib/sqlite/listItemsRepository';
import { ITEM_SCROLL_FETCH_RATIO, mayShowEmptyState } from '../model/listDetail';
import { openInMaps } from '../model/openInMaps';
import { planStateLine, spokenPlanStateLine } from '../model/planStateLine';
import { orderedItems, reorderRange } from '../model/reorder';
import { ListAddRow } from './ListAddRow';
import { ListEmptyState } from './ListEmptyState';
import { ListHeader } from './ListHeader';
import { ListItemRow } from './ListItemRow';
import { ReorderableList } from './ReorderableList';
import { isGroupedStageList, StateSections } from './StateSections';

export interface ListDetailSurfaceProps {
  list: List | undefined;
  items: readonly ListItemRowData[];
  itemCount: number;
  /**
   * The user's today, injected by the route (`coding-standards.md` §4.3), for the state
   * line's relative words. Absent — as in the deterministic gallery — no line renders, which
   * is also correct: a line whose `Saturday` cannot be trusted is worse than none.
   */
  today?: string;
  /** Opens the caller's linked Plan from its state line (P3-35). */
  onOpenPlan?: (activityId: string) => void;
  complete: boolean;
  status: 'pending' | 'success' | 'error';
  requestId?: string;
  onBack: () => void;
  onOpenMenu: () => void;
  onRename: (title: string) => void;
  onRetry: () => void;
  onLoadMore: () => void;
  onAdd: () => void;
  addEditor?: ReactNode;
  onOpenItem: (item: ListItemView) => void;
  onToggleChecked: (
    item: ListItemView,
    checked: boolean,
  ) => boolean | Promise<boolean | undefined> | undefined;
  onDrop: (itemId: string, toIndex: number) => void;
}

/** Production List-detail layout, shared by the live screen and its deterministic gallery. */
export function ListDetailSurface({
  list,
  items,
  itemCount,
  today,
  onOpenPlan,
  complete,
  status,
  requestId,
  onBack,
  onOpenMenu,
  onRename,
  onRetry,
  onLoadMore,
  onAdd,
  addEditor,
  onOpenItem,
  onToggleChecked,
  onDrop,
}: ListDetailSurfaceProps) {
  /** The row's state-line props, derived once so both layouts say the same thing. */
  const stateLineProps = useCallback(
    (item: ListItemRowData) => {
      if (today === undefined) return {};
      const line = planStateLine(item.viewerPlan, today);
      const spoken = spokenPlanStateLine(item.viewerPlan, today);
      const activityId = item.viewerLink?.activityId;
      return {
        ...(item.viewerPlan === undefined ? {} : { viewerPlan: item.viewerPlan }),
        ...(line === undefined ? {} : { planStateLine: line }),
        ...(spoken === undefined ? {} : { planStateLineSpoken: spoken }),
        ...(onOpenPlan === undefined || activityId === undefined
          ? {}
          : { onOpenPlan: () => onOpenPlan(activityId) }),
      };
    },
    [today, onOpenPlan],
  );
  const theme = useTheme();
  const showEmpty = mayShowEmptyState(
    { itemCount, loadedCount: items.length, complete },
    status !== 'pending' && status !== 'error',
  );
  const onScroll = useCallback(
    (event: {
      nativeEvent: {
        contentOffset: { y: number };
        contentSize: { height: number };
        layoutMeasurement: { height: number };
      };
    }) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      const depth =
        (contentOffset.y + layoutMeasurement.height) / Math.max(1, contentSize.height);
      if (depth >= ITEM_SCROLL_FETCH_RATIO) onLoadMore();
    },
    [onLoadMore],
  );

  return (
    <ScreenShell
      header={
        <ListHeader
          list={list}
          itemCount={itemCount}
          onBack={onBack}
          onOpenMenu={onOpenMenu}
          onRename={onRename}
        />
      }
      bodySpacing="compact"
      onScroll={onScroll}
      scrollEventThrottle={16}
      keepEndVisibleWithKeyboard={addEditor !== undefined}
      testID="list-detail"
    >
      <View style={{ gap: theme.space[3] }}>
        {/*
         * Connectivity and refresh state live in the header's cloud glyph (founder,
         * 2026-08-31): inline lines here reflowed the rows every time they appeared. Only
         * the empty-failure class keeps the body — there is nothing else to show.
         */}
        {status === 'error' && items.length === 0 ? (
          <View testID="list-detail-error">
            <EmptyState
              heading="Couldn't load this."
              action={{ label: 'Try again', onPress: onRetry }}
            />
            {requestId === undefined ? null : (
              <Text
                variant="footnote"
                color="textSecondary"
                align="center"
                selectable
                testID="list-detail-request-id"
              >
                {requestId}
              </Text>
            )}
          </View>
        ) : null}

        {status === 'pending' ? (
          <View testID="list-detail-loading">
            <Skeleton shape="row" count={5} />
          </View>
        ) : showEmpty && list !== undefined ? (
          <View style={{ gap: theme.space[5] }}>
            <ListEmptyState
              body={list.emptyStateCopy}
              {...(addEditor === undefined ? { onAdd } : {})}
            />
            {addEditor}
          </View>
        ) : list === undefined ? null : isGroupedStageList(list) ? (
          <View>
            <StateSections
              list={list}
              items={items}
              onOpen={onOpenItem}
              onDrop={onDrop}
              rowExtras={stateLineProps}
            />
          </View>
        ) : (
          <View>
            <ReorderableList
              items={orderedItems(items)}
              keyOf={(item) => item.itemId}
              labelOf={(item) => item.title}
              rangeOf={(itemId) => reorderRange(list, items, itemId)}
              handleAppearance="quiet"
              onDrop={onDrop}
              testID="list-detail-items"
              renderItem={(item) => (
                <ListItemRow
                  list={list}
                  item={item}
                  onOpen={() => onOpenItem(item)}
                  onToggleChecked={(next) => onToggleChecked(item, next)}
                  {...(item.features?.place === undefined
                    ? {}
                    : { onOpenLocation: () => void openInMaps(item.features?.place) })}
                  {...stateLineProps(item)}
                  testID={`list-item-${item.itemId}`}
                />
              )}
            />
          </View>
        )}

        {addEditor !== undefined && itemCount > 0 ? (
          addEditor
        ) : list === undefined || itemCount === 0 || addEditor !== undefined ? null : (
          <ListAddRow listName={list.title} onPress={onAdd} />
        )}
      </View>
    </ScreenShell>
  );
}
