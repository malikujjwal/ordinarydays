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
import { useReorderItems } from '../hooks/useReorderItems';
import { useWatchActions } from '../hooks/useWatchActions';
import {
  checkedCount,
  ITEM_SCROLL_FETCH_RATIO,
  mayActOnWholeList,
  mayShowEmptyState,
} from '../model/listDetail';
import { watchItemSwipeActions } from '../model/listSwipeActions';
import { openInMaps } from '../model/openInMaps';
import { orderedItems, reorderRange } from '../model/reorder';
import { groupDropIndex } from '../model/watchSections';
import { AddItemRow } from './AddItemRow';
import { ListHeaderMenu } from './ListHeaderMenu';
import { ListItemRow } from './ListItemRow';
import { ReorderableList } from './ReorderableList';
import { WatchSections } from './WatchSections';

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
 * Rows are `ListItemRow`, the one capability-driven renderer (P3-28) — this screen hands it the
 * list's own `behaviour` and `capabilities` and nothing else. There is no item sheet (P3-29)
 * and no rename or settings (P3-32), so a row body tap does nothing yet rather than pretending
 * to open something.
 *
 * ## The drag is wrapped around the rows, not built into them
 *
 * ## One behaviour renders grouped, and it is chosen off the stored field
 *
 * `behaviour === 'watch'` renders `WatchSections`; everything else renders flat. The choice is
 * the **row's own stored value** and nothing else (ADR-032), so a list changed away from
 * `watch` renders flat the moment its committed projection says so — no template key, no
 * capability, no second condition (§P3-31's edge case).
 *
 * ## The drag
 *
 * `ReorderableList` owns the gesture — a long press on native, §7.1's hover handle on web — and
 * calls back with an insertion index. Everything that decides what that index *means* is
 * `reorder.ts`'s, and everything that writes it is `useReorderItems`'. The row renderer is
 * untouched: a row does not know it can be dragged, which is what keeps P3-28's one renderer
 * one renderer.
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
  const watch = useWatchActions(view.refresh);
  const reorder = useReorderItems({
    listId,
    /*
     * The behaviour only. A reorder reads no capability — `checkable` does not make a row
     * un-draggable and `supportsLocation` has nothing to say about position — so handing the
     * whole list row would be handing over fields nothing here may branch on.
     */
    list: { behaviour: view.list?.behaviour ?? 'collection' },
    items: view.items,
    applyRank: view.applyRank,
    onMoved: view.refresh,
  });

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
        ) : list === undefined ? null : list.behaviour === 'watch' ? (
          /*
           * §5.2's one grouped list. The rows are the same `ListItemRow`; only the headings and
           * the per-section drag surface are new, and the drop index each section reports is
           * translated back into the flat position `afterItemId` speaks.
           */
          <WatchSections
            list={list}
            items={view.items}
            /*
             * §3.2 gives this row `Mark watched` · `Delete`. Only the first has a handler on
             * `main`: the item delete and its undo belong to P3-29, which has not landed, and
             * an action nothing can perform is absent rather than present and inert.
             */
            actions={watchItemSwipeActions().filter(
              (action) => action.name === 'mark-watched',
            )}
            onAction={(item, action) => {
              if (action.name === 'mark-watched') watch.markWatched(listId, item);
            }}
            onReorder={(itemId, withinGroup) => {
              const flat = groupDropIndex(view.items, itemId, withinGroup);
              if (flat !== undefined) reorder.drop(itemId, flat);
            }}
            testID="list-detail-items"
          />
        ) : (
          /*
           * §5.6: reorder is offered on **every** behaviour, and a checked row reorders like
           * any other and stays where it is put. The only thing a behaviour changes is how far
           * a row may travel, which `reorderRange` decides and neither this screen nor the
           * gesture second-guesses.
           */
          <ReorderableList
            /*
             * Sorted here as well as by the projection, and deliberately: `(rank, itemId)` is
             * the order both platforms already produce, and passing it through the one exported
             * comparator on the way to the screen means a restored, legacy or seeded duplicate
             * rank renders identically on two devices whichever order it reached them in
             * (acceptance criterion 29). It is a no-op on an already-ordered projection.
             */
            items={orderedItems(view.items)}
            keyOf={(item) => item.itemId}
            rangeOf={(itemId) => reorderRange(list, view.items, itemId)}
            onDrop={reorder.drop}
            testID="list-detail-items"
            renderItem={(item) => (
              /*
               * The row is handed the list's own `behaviour` and `capabilities` and nothing
               * else — not the title, not the template key. That narrowing is the whole of
               * ADR-032 at the call site (P3-28).
               */
              <ListItemRow
                list={list}
                item={item}
                onOpenLocation={() => void openInMaps(item.location)}
                testID={`list-item-${item.itemId}`}
              />
            )}
          />
        )}

        {list === undefined ? null : (
          <AddItemRow
            listName={list.title}
            onAdd={async (title) => {
              const itemId = await add.add(listId, { title });
              // Re-read from wherever this platform's truth is; the hook decides which.
              if (itemId !== undefined) view.refresh();
              return itemId;
            }}
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
