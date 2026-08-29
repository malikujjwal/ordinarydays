import type { List } from '@od/shared/types';
import { EmptyState, ScreenShell, Skeleton, Text, useTheme } from '@od/ui';
import { useCallback, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useAddListItem } from '@/hooks/useAddListItem';
import { useListBulkActions } from '../hooks/useListBulkActions';
import { useListDetail } from '../hooks/useListDetail';
import { useListItemActions } from '../hooks/useListItemActions';
import { useListSettings } from '../hooks/useListSettings';
import { useReorderItems } from '../hooks/useReorderItems';
import {
  doneCount,
  ITEM_SCROLL_FETCH_RATIO,
  mayActOnWholeList,
  mayShowEmptyState,
} from '../model/listDetail';
import { openInMaps } from '../model/openInMaps';
import { orderedItems, reorderRange } from '../model/reorder';
import { AddItemRow } from './AddItemRow';
import { ItemSheet } from './ItemSheet';
import { ListHeader } from './ListHeader';
import { ListHeaderMenu } from './ListHeaderMenu';
import { ListItemRow } from './ListItemRow';
import { ListSettingsSheet } from './ListSettingsSheet';
import { ReorderableList } from './ReorderableList';
import { StateSections } from './StateSections';

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
 * Rows are `ListItemRow`, the one configuration-driven renderer — this screen hands it the
 * List's state mode and typed-feature configuration. A body tap opens P3-29's
 * `ItemSheet`, and its checkbox writes through the same item PATCH path the sheet uses.
 *
 * ## Settings arrive through one overlay, not through five call sites
 *
 * `useListSettings` owns rename, state exposure, typed features and the slot
 * change (P3-32), and this screen reads `settings.view` — the committed row with the user's
 * un-acknowledged change drawn over it — as **the** list. Everything below renders from that one
 * value, so a toggle cannot show as on in the sheet while the rows below it still draw no
 * checkbox. Rename is inline on `ListHeader`'s title and appears in no menu (§5.6).
 *
 * ## State writes are explicit
 *
 * A checkbox writes `done` or `open`; it never inverts server state. Grouped stage rendering
 * is selected only by the stored `itemStateMode`, and each populated state owns its drag
 * surface so reordering cannot change state.
 *
 * ## The drag
 *
 * `ReorderableList` owns the gesture — a long press on native, §7.1's hover handle on web — and
 * calls back with an insertion index. Everything that decides what that index *means* is
 * `reorder.ts`'s, and everything that writes it is `useReorderItems`'. The row renderer is
 * untouched: a row does not know it can be dragged, which is what keeps P3-28's one renderer
 * one renderer.
 *
 * ## The open row is held by id, not by value
 *
 * `ItemSheet` is handed the row **out of `view.items`** each render, so a save that refreshes
 * the projection reaches the open sheet as new committed values rather than leaving it editing
 * a copy taken when it opened. An item deleted underneath — by Undo expiring, or by another
 * member — closes the sheet rather than editing a row that is gone.
 */
export interface ListDetailScreenProps {
  listId: string;
  onBack: () => void;
  /**
   * Opens an Activity, for §7.5's provenance row inside the item sheet.
   *
   * Owned by the route, like every other navigation on this screen. Absent leaves the
   * provenance row plain text, which is what it is on the row itself in v1.
   */
  onOpenActivity?: (activityId: string) => void;
}

export function ListDetailScreen({
  listId,
  onBack,
  onOpenActivity,
}: ListDetailScreenProps) {
  const theme = useTheme();
  const view = useListDetail(listId);
  const add = useAddListItem();
  const bulk = useListBulkActions(view.refetch);
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [openItemId, setOpenItemId] = useState<string>();
  const openItem = view.items.find((candidate) => candidate.itemId === openItemId);
  const items = useListItemActions({ onSaved: view.refresh, onRemoved: view.refetch });
  /*
   * `refresh` for a change this device accepted — native re-reads SQLite, web asks the server —
   * and `refetch` for the online downgrade preview that turned out to lose nothing and was
   * applied server-side, which no local projection knows about. The same split `ItemSheet` takes.
   */
  const settings = useListSettings({
    list: view.list,
    onChanged: view.refresh,
    onServerChanged: view.refetch,
  });
  const reorder = useReorderItems({
    listId,
    /*
     * Reorder reads only state presentation. In grouped stages it constrains movement to the
     * current group; in every other mode the whole ordered list is one drag surface.
     */
    list: { itemStateMode: settings.view?.itemStateMode ?? { mode: 'none' } },
    items: view.items,
    applyRank: view.applyRank,
    onMoved: view.refresh,
  });

  // Retire each pending tick as the projection catches up with it, and never before.
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

  /*
   * One overlay, applied once, so the header, the rows, the `⋯` menu and the settings sheet all
   * draw the same optimistic truth. A sheet showing checkboxes on while the rows below still
   * drew none is the flicker §1a.1's "applies immediately, optimistically" exists to prevent.
   */
  const list = settings.view;

  const header = (
    <ListHeader
      list={list}
      onBack={onBack}
      onOpenMenu={() => setMenuOpen(true)}
      onRename={settings.rename}
    />
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
        ) : list === undefined ? null : list.itemStateMode.mode === 'stages' &&
          list.itemStateMode.groupByState ? (
          <StateSections
            list={
              list as List & {
                itemStateMode: Extract<List['itemStateMode'], { mode: 'stages' }>;
              }
            }
            items={view.items}
            onOpen={(item) => setOpenItemId(item.itemId)}
            onDrop={reorder.drop}
          />
        ) : (
          /* Reorder is offered in every mode and never mutates item state. */
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
              /* The renderer reads stored configuration, never creation provenance. */
              <ListItemRow
                list={list}
                item={item}
                onOpen={() => setOpenItemId(item.itemId)}
                onToggleChecked={(next) =>
                  items.save(item, {
                    state: next ? 'done' : item.state === 'done' ? 'open' : item.state,
                  })
                }
                {...(item.features?.place === undefined
                  ? {}
                  : { onOpenLocation: () => void openInMaps(item.features?.place) })}
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

      {list === undefined || openItem === undefined ? null : (
        <ItemSheet
          open
          list={list}
          item={openItem}
          onClose={() => setOpenItemId(undefined)}
          /*
           * The same pair the screen already draws on: `refresh` for a write this device has
           * committed — native re-reads SQLite, web asks the server — and `refetch` for the
           * online delete, which only the server knows about. `useListBulkActions` takes
           * `refetch` for its deletes for exactly this reason.
           */
          onChanged={view.refresh}
          onRemoved={view.refetch}
          {...(onOpenActivity === undefined ? {} : { onOpenSource: onOpenActivity })}
        />
      )}

      {list === undefined ? null : (
        <ListHeaderMenu
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          list={list}
          /*
           * Zero until every page has landed, which makes `Uncheck all` absent rather than
           * wrong: it is offered only when its count is the whole list's, and that count is
           * what pays for there being no confirmation dialog (§P3-10).
           */
          checkedCount={mayActOnWholeList(progress) ? doneCount(view.items) : 0}
          onClearDone={() => {
            setMenuOpen(false);
            bulk.clearDone(listId);
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
          onOpenSettings={() => {
            setMenuOpen(false);
            setSettingsOpen(true);
          }}
        />
      )}

      {list === undefined ? null : (
        <ListSettingsSheet
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          list={list}
          settings={settings}
        />
      )}
    </ScreenShell>
  );
}
