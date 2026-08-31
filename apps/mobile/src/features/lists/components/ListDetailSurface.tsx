import type { List, ListItemView } from '@od/shared/types';
import { EmptyState, ScreenShell, Skeleton, Text, useTheme } from '@od/ui';
import type { ReactNode } from 'react';
import { useCallback } from 'react';
import { View } from 'react-native';
import { countLine } from '../model/listCard';
import { ITEM_SCROLL_FETCH_RATIO, mayShowEmptyState } from '../model/listDetail';
import { openInMaps } from '../model/openInMaps';
import { orderedItems, reorderRange } from '../model/reorder';
import { ListAddRow } from './ListAddRow';
import { ListEmptyState } from './ListEmptyState';
import { ListHeader } from './ListHeader';
import { ListItemRow } from './ListItemRow';
import { ListOverview } from './ListOverview';
import { ReorderableList } from './ReorderableList';
import { isGroupedStageList, StateSections } from './StateSections';

export interface ListDetailSurfaceProps {
  list: List | undefined;
  items: readonly ListItemView[];
  itemCount: number;
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
          <View style={{ gap: theme.space[3] }}>
            <ListOverview count={countLine(list)} />
            <StateSections
              list={list}
              items={items}
              onOpen={onOpenItem}
              onDrop={onDrop}
            />
          </View>
        ) : (
          <View style={{ gap: theme.space[2] }}>
            <ListOverview count={countLine(list)} />
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
