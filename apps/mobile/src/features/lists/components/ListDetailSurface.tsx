import type { List, ListItemView } from '@od/shared/types';
import {
  EmptyState,
  ScreenShell,
  Skeleton,
  Text,
  useKeyboardInset,
  useScrollToFocusedInput,
  useTheme,
} from '@od/ui';
import type { ReactNode } from 'react';
import { useCallback, useRef } from 'react';
import {
  type ScrollView as RNScrollView,
  ScrollView,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
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
  isOffline: boolean;
  message?: string;
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

/** Stable room below rapid entry: keyboard replaces, rather than accumulates with, safe area. */
export const listDetailScrollBottomPadding = (
  keyboardInset: number,
  safeAreaBottom: number,
  spacing: number,
): number => (keyboardInset > 0 ? keyboardInset : safeAreaBottom) + spacing;

/** Production List-detail layout, shared by the live screen and its deterministic gallery. */
export function ListDetailSurface({
  list,
  items,
  itemCount,
  complete,
  status,
  isOffline,
  message,
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
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardInset();
  const scrollRef = useRef<RNScrollView | null>(null);
  const { height: viewportHeight } = useWindowDimensions();
  useScrollToFocusedInput(scrollRef, keyboard, viewportHeight);
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
      scroll={false}
      bodySpacing="compact"
      testID="list-detail"
    >
      <ScrollView
        ref={scrollRef}
        onScroll={onScroll}
        scrollEventThrottle={16}
        automaticallyAdjustKeyboardInsets
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          gap: theme.space[3],
          paddingBottom: listDetailScrollBottomPadding(
            keyboard,
            insets.bottom,
            theme.space[5],
          ),
        }}
        testID="list-detail-scroll"
      >
        {isOffline ? (
          <Text variant="footnote" color="textSecondary">
            You're offline. Showing saved data.
          </Text>
        ) : null}

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
        ) : message === undefined ? null : (
          <Text variant="footnote" color="danger" testID="list-detail-refresh-failed">
            Couldn't refresh. Try again.
          </Text>
        )}

        {status === 'pending' ? (
          <View testID="list-detail-loading">
            <Skeleton shape="row" count={5} />
          </View>
        ) : showEmpty && list !== undefined && addEditor === undefined ? (
          <ListEmptyState body={list.emptyStateCopy} onAdd={onAdd} />
        ) : showEmpty && list !== undefined ? (
          addEditor
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
      </ScrollView>
    </ScreenShell>
  );
}
