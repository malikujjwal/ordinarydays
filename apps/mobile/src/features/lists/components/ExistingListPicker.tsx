import { Button, type SheetVirtualizedBodyProps, Text, useTheme } from '@od/ui';
import { useCallback } from 'react';
import { FlatList, type ListRenderItemInfo, Platform, View } from 'react-native';
import type { ListIndexEntry, ListsView } from '../hooks/useLists';
import { ExistingListPickerRow } from './ExistingListPickerRow';
import { LoadMoreFailure } from './LoadMoreFailure';

interface ExistingListPickerProps {
  readonly lists: ListsView;
  readonly active: readonly ListIndexEntry[];
  readonly sourceActivityId: string;
  readonly selectedId: string | undefined;
  readonly onSelect: (listId: string) => void;
  readonly attachError: string | undefined;
  readonly attachRequestId: string | undefined;
  readonly sheetScroll: SheetVirtualizedBodyProps;
}

export function listAttachDisabledReason(
  list: ListIndexEntry,
  sourceActivityId: string,
  viewerUserId: string | undefined,
): string | undefined {
  if (list.sourceActivityId === sourceActivityId) return 'Already added';
  if (list.sourceActivityId !== undefined) return 'Already connected to a plan';
  if (list.ownerId !== viewerUserId) return 'Only the owner can add this list';
  return undefined;
}

/** FlatList owns pagination and scrolling; the enclosing Sheet owns only its fixed chrome. */
export function ExistingListPicker({
  lists,
  active,
  sourceActivityId,
  selectedId,
  onSelect,
  attachError,
  attachRequestId,
  sheetScroll,
}: ExistingListPickerProps) {
  const theme = useTheme();
  const firstPageFailed =
    lists.status === 'error' &&
    (active.length === 0 || lists.viewerUserId === undefined) &&
    lists.loadMoreFailure === undefined;
  const visibleLists = lists.viewerUserId === undefined ? [] : active;
  const renderItem = useCallback(
    ({ item: list }: ListRenderItemInfo<ListIndexEntry>) => (
      <ExistingListPickerRow
        listId={list.listId}
        title={list.title}
        itemCount={list.itemCount}
        selected={list.listId === selectedId}
        disabledReason={listAttachDisabledReason(
          list,
          sourceActivityId,
          lists.viewerUserId,
        )}
        onSelect={onSelect}
      />
    ),
    [lists.viewerUserId, onSelect, selectedId, sourceActivityId],
  );

  return (
    <FlatList<ListIndexEntry>
      testID="plan-list-choices"
      data={visibleLists}
      keyExtractor={(list) => list.listId}
      initialNumToRender={12}
      windowSize={7}
      removeClippedSubviews={Platform.OS !== 'web'}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ flexGrow: 1 }}
      onScroll={sheetScroll.onScroll}
      scrollEventThrottle={sheetScroll.scrollEventThrottle}
      onEndReached={() => {
        if (
          lists.hasMore &&
          !lists.isLoadingMore &&
          lists.loadMoreFailure === undefined
        ) {
          lists.loadMore();
        }
      }}
      onEndReachedThreshold={0.4}
      ListHeaderComponent={
        attachError === undefined ? null : (
          <View
            accessibilityRole="alert"
            style={{ gap: theme.space[1], paddingBottom: theme.space[4] }}
          >
            <Text variant="footnote" color="danger">
              {attachError}
            </Text>
            {attachRequestId === undefined ? null : (
              <Text variant="footnote" color="textSecondary" selectable>
                {attachRequestId}
              </Text>
            )}
          </View>
        )
      }
      ListEmptyComponent={
        lists.status === 'pending' ? (
          <Text variant="body" color="textSecondary">
            Loading lists…
          </Text>
        ) : firstPageFailed ? (
          <View accessibilityRole="alert" style={{ gap: theme.space[3] }}>
            <Text variant="body" color="danger">
              {lists.message ?? "Couldn't load lists."}
            </Text>
            {lists.requestId === undefined ? null : (
              <Text variant="footnote" color="textSecondary" selectable>
                {lists.requestId}
              </Text>
            )}
            <Button label="Retry" variant="secondary" onPress={lists.refetch} />
          </View>
        ) : lists.loadMoreFailure !== undefined ? (
          <LoadMoreFailure failure={lists.loadMoreFailure} />
        ) : lists.hasMore ? (
          <View style={{ gap: theme.space[3] }}>
            <Text variant="body" color="textSecondary">
              Looking for active lists…
            </Text>
            <Button
              label="Load more lists"
              variant="secondary"
              onPress={lists.loadMore}
              loading={lists.isLoadingMore}
            />
          </View>
        ) : (
          <Text variant="body" color="textSecondary">
            No active lists yet.
          </Text>
        )
      }
      ListFooterComponent={
        visibleLists.length === 0 ? null : lists.loadMoreFailure !== undefined ? (
          <View style={{ paddingTop: theme.space[4] }}>
            <LoadMoreFailure failure={lists.loadMoreFailure} />
          </View>
        ) : lists.hasMore ? (
          <View style={{ paddingTop: theme.space[4] }}>
            <Button
              label="Load more lists"
              variant="ghost"
              onPress={lists.loadMore}
              loading={lists.isLoadingMore}
            />
          </View>
        ) : null
      }
      renderItem={renderItem}
    />
  );
}
