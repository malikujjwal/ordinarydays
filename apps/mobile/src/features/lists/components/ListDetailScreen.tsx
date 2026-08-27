import {
  Button,
  EmptyState,
  IconButton,
  MoreHorizontal,
  ScreenShell,
  Skeleton,
  Text,
  useTheme,
} from '@od/ui';
import { useCallback, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useAddListItem } from '@/hooks/useAddListItem';
import { useListBulkActions } from '../hooks/useListBulkActions';
import { useListDetail } from '../hooks/useListDetail';
import {
  checkedCount,
  ITEM_SCROLL_FETCH_RATIO,
  mayActOnWholeList,
  mayShowEmptyState,
} from '../model/listDetail';
import { AddItemRow } from './AddItemRow';
import { ListHeaderMenu } from './ListHeaderMenu';
import { ListItemTitleRow } from './ListItemTitleRow';

/**
 * One list, its items and its inline add row
 * ([`plans-and-lists.md`](../../../../../docs/01-product/plans-and-lists.md) §5.6, §5.9,
 * §P3-27).
 *
 * ## The empty state is the list's own words
 *
 * Fixed heading `Nothing here`, then the `emptyStateCopy` **stored on the row** at creation —
 * never a `templateKey` lookup, never guidance regenerated from behaviour or capabilities
 * (ADR-032, and the feature's grep test covers this file). A template edited a year later
 * cannot change what a list somebody already has says about itself.
 *
 * ## A loaded page is not the list
 *
 * Both decisions that could get this wrong read META's `itemCount` rather than `items.length`:
 * `Nothing here` needs the server's zero **and** no visible row, and the bulk actions are
 * offered only once every page has landed — a menu reading `Clear checked (3)` on a list with
 * forty checked rows further down would be lying about the write it is about to make
 * (criterion 36).
 *
 * ## What this screen deliberately does not do
 *
 * Rows are `ListItemTitleRow`, which P3-28 replaces with the capability-driven renderer; there
 * is no checkbox, no reorder (P3-30), no item sheet (P3-29), and no rename or settings
 * (P3-32). Tapping a row does nothing yet rather than pretending to open something.
 */
export interface ListDetailScreenProps {
  listId: string;
  onBack: () => void;
}

export function ListDetailScreen({ listId, onBack }: ListDetailScreenProps) {
  const theme = useTheme();
  const view = useListDetail(listId);
  const add = useAddListItem();
  const bulk = useListBulkActions(view.refetch);
  const [menuOpen, setMenuOpen] = useState(false);

  const progress = {
    itemCount: view.itemCount,
    loadedCount: view.items.length,
    complete: view.complete,
  };
  const showEmpty =
    mayShowEmptyState(progress, view.status !== 'pending') && view.status !== 'error';

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
      if (depth >= ITEM_SCROLL_FETCH_RATIO) view.loadMore();
    },
    [view.loadMore],
  );

  const list = view.list;

  const header = (
    <View style={{ gap: theme.space[2], paddingBottom: theme.space[3] }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <Button
          label="Back"
          variant="ghost"
          flush
          onPress={onBack}
          testID="list-detail-back"
        />
        {list === undefined ? null : (
          <IconButton
            icon={MoreHorizontal}
            label="More"
            onPress={() => setMenuOpen(true)}
            testID="list-detail-menu"
          />
        )}
      </View>
      <Text variant="display" color="textDisplay" accessibilityRole="header">
        {list?.title ?? 'List'}
      </Text>
    </View>
  );

  return (
    <ScreenShell header={header} scroll={false} testID="list-detail">
      <ScrollView
        onScroll={onScroll}
        scrollEventThrottle={16}
        contentContainerStyle={{ gap: theme.space[3] }}
        testID="list-detail-scroll"
      >
        {view.isOffline ? (
          <Text variant="footnote" color="textSecondary">
            You're offline. Showing saved data.
          </Text>
        ) : null}

        {/* §5.3's two failure classes: rows on screen keep them and show a line above. */}
        {view.status === 'error' && view.items.length === 0 ? (
          <View testID="list-detail-error">
            <EmptyState
              heading="Couldn't load this."
              action={{ label: 'Try again', onPress: view.refetch }}
            />
            {view.requestId === undefined ? null : (
              <Text
                variant="footnote"
                color="textSecondary"
                align="center"
                selectable
                testID="list-detail-request-id"
              >
                {view.requestId}
              </Text>
            )}
          </View>
        ) : view.message === undefined ? null : (
          <Text variant="footnote" color="danger" testID="list-detail-refresh-failed">
            Couldn't refresh. Try again.
          </Text>
        )}

        {view.status === 'pending' ? (
          <View testID="list-detail-loading">
            <Skeleton shape="row" count={5} />
          </View>
        ) : showEmpty && list !== undefined ? (
          /*
           * §5.9 verbatim: the fixed heading, then this list's own stored copy. `EmptyState`
           * carries no action — the persistent add row below is §5.6's contextual action, and
           * a second one would be two controls for one thing.
           */
          <EmptyState
            heading="Nothing here"
            body={list.emptyStateCopy}
            testID="list-detail-empty"
          />
        ) : (
          <View testID="list-detail-items">
            {view.items.map((item) => (
              <ListItemTitleRow
                key={item.itemId}
                item={item}
                testID={`list-item-${item.itemId}`}
              />
            ))}
          </View>
        )}

        {list === undefined ? null : (
          <AddItemRow
            listName={list.title}
            onAdd={(title) => add.add(listId, { title })}
            isAdding={add.isAdding}
            autoFocus={showEmpty}
            {...(add.errorMessage === undefined
              ? {}
              : { errorMessage: add.errorMessage })}
          />
        )}
      </ScrollView>

      {list === undefined ? null : (
        <ListHeaderMenu
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          list={list}
          /*
           * Zero until every page has landed, which makes `Clear checked` absent rather than
           * wrong: it is offered only when its count is the whole list's, and that count is
           * what pays for there being no confirmation dialog (§P3-10).
           */
          checkedCount={mayActOnWholeList(progress) ? checkedCount(view.items) : 0}
          onClearChecked={() => {
            setMenuOpen(false);
            bulk.clearChecked(listId);
          }}
          onUncheckAll={() => {
            setMenuOpen(false);
            bulk.uncheckAll(listId);
          }}
          onArchive={() => {
            setMenuOpen(false);
            bulk.archive(list);
            // Archiving leaves the index, so it leaves this screen with it (§5.6).
            onBack();
          }}
        />
      )}
    </ScreenShell>
  );
}
