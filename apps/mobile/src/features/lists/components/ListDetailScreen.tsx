import { useState } from 'react';
import { View } from 'react-native';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useAddListItem } from '@/hooks/useAddListItem';
import { useListBulkActions } from '../hooks/useListBulkActions';
import { useListDetail } from '../hooks/useListDetail';
import { useListItemActions } from '../hooks/useListItemActions';
import { useListSettings } from '../hooks/useListSettings';
import { useReorderItems } from '../hooks/useReorderItems';
import { deleteListConfirmation } from '../model/deleteConfirmation';
import { doneCount, mayActOnWholeList } from '../model/listDetail';
import { InlineListItemEditor } from './InlineListItemEditor';
import { ItemSheet } from './ItemSheet';
import { ListDetailSurface } from './ListDetailSurface';
import { ListHeaderMenu } from './ListHeaderMenu';
import { ListSettingsSheet } from './ListSettingsSheet';

/**
 * One list, its items and its contextual composer
 * ([`plans-and-lists.md`](../../../../../docs/01-product/plans-and-lists.md) §5.6, §5.9,
 * §P3-27).
 *
 * ## The empty state is the list's own words
 *
 * Fixed heading `Start with one item`, then the `emptyStateCopy` **stored on the row** at
 * creation — never a `templateKey` lookup, never guidance regenerated from behaviour or
 * capabilities (ADR-032, and the feature's grep test covers this file). A template edited a
 * year later cannot change what a list somebody already has says about itself.
 *
 * ## A loaded page is not the list
 *
 * Both decisions that could get this wrong read META's `itemCount` rather than `items.length`:
 * the empty state needs the server's zero **and** no visible row, and the bulk actions are
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
 * `ReorderableList` owns the gesture and its 44-point handle — persistent on touch and revealed
 * by hover or focus on pointer layouts — and calls back with an insertion index. Everything
 * that decides what that index *means* is `reorder.ts`'s, and everything that writes it is
 * `useReorderItems`'. The row renderer is untouched: a row does not know it can be dragged,
 * which is what keeps P3-28's one renderer one renderer.
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
  const view = useListDetail(listId);
  const add = useAddListItem();
  const bulk = useListBulkActions(view.refetch);
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [openItemId, setOpenItemId] = useState<string>();
  const openItem = view.items.find((candidate) => candidate.itemId === openItemId);
  const items = useListItemActions({
    onSaved: view.refresh,
    onRemoving: view.refresh,
    onRemoved: view.refetch,
  });
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
  /*
   * One overlay, applied once, so the header, the rows, the `⋯` menu and the settings sheet all
   * draw the same optimistic truth. A sheet showing checkboxes on while the rows below still
   * drew none is the flicker §1a.1's "applies immediately, optimistically" exists to prevent.
   */
  const list = settings.view;

  return (
    <View style={{ flex: 1 }}>
      <ListDetailSurface
        list={list}
        items={reorder.items}
        itemCount={view.itemCount}
        complete={view.complete}
        status={view.status}
        isOffline={view.isOffline}
        {...(view.message === undefined ? {} : { message: view.message })}
        {...(view.requestId === undefined ? {} : { requestId: view.requestId })}
        onBack={onBack}
        onOpenMenu={() => setMenuOpen(true)}
        onRename={settings.rename}
        onRetry={view.refetch}
        onLoadMore={view.loadMore}
        onAdd={() => setAddOpen(true)}
        {...(addOpen && list !== undefined
          ? {
              addEditor: (
                <InlineListItemEditor
                  isAdding={add.isAdding}
                  {...(add.errorMessage === undefined
                    ? {}
                    : { errorMessage: add.errorMessage })}
                  {...(add.errorRequestId === undefined
                    ? {}
                    : { errorRequestId: add.errorRequestId })}
                  onChange={add.dismissError}
                  onAdd={async (title) => {
                    const itemId = await add.add(listId, { title });
                    if (itemId !== undefined) view.refresh();
                    return itemId;
                  }}
                />
              ),
            }
          : {})}
        onOpenItem={(item) => setOpenItemId(item.itemId)}
        onToggleChecked={(item, next) =>
          items.save(item, {
            state: next ? 'done' : item.state === 'done' ? 'open' : item.state,
          })
        }
        onDrop={reorder.drop}
      />

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
          onDelete={() => {
            setMenuOpen(false);
            setDeleteOpen(true);
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

      {list === undefined ? null : (
        <ConfirmDialog
          open={deleteOpen}
          centred
          confirmation={deleteListConfirmation(list)}
          onCancel={() => setDeleteOpen(false)}
          onConfirm={() => {
            setDeleteOpen(false);
            bulk.remove(list);
            onBack();
          }}
          testID="list-delete-confirm"
        />
      )}
    </View>
  );
}
