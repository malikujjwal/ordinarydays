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
import { useCallback, useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useAddListItem } from '@/hooks/useAddListItem';
import { useListBulkActions } from '../hooks/useListBulkActions';
import { useListDetail } from '../hooks/useListDetail';
import { useListItemActions } from '../hooks/useListItemActions';
import {
  type CheckedOverrides,
  isChecked,
  NO_OVERRIDES,
  settleOverrides,
  withOverride,
  withoutOverride,
} from '../model/checkedOverride';
import {
  checkedCount,
  ITEM_SCROLL_FETCH_RATIO,
  mayActOnWholeList,
  mayShowEmptyState,
} from '../model/listDetail';
import { openInMaps } from '../model/openInMaps';
import { AddItemRow } from './AddItemRow';
import { ItemSheet } from './ItemSheet';
import { ListHeaderMenu } from './ListHeaderMenu';
import { ListItemRow } from './ListItemRow';

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
 * list's own `behaviour` and `capabilities` and nothing else. A body tap opens P3-29's
 * `ItemSheet` and the checkbox writes through the same item PATCH path the sheet uses; there is
 * still no reorder (P3-30) and no rename or settings (P3-32).
 *
 * ## The tick is a set, and it is drawn before the server agrees
 *
 * `onToggleChecked` receives the **next** value and sends it as `checked: next` — never
 * `!checked` recomputed anywhere (§5.11.5). Until the projection carries that value the row
 * draws it from `checkedOverride.ts`, so two people ticking `Milk` at once end with it checked
 * once, and neither of them watches it flicker.
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
  const [openItemId, setOpenItemId] = useState<string>();
  const [checks, setChecks] = useState<CheckedOverrides>(NO_OVERRIDES);
  const openItem = view.items.find((candidate) => candidate.itemId === openItemId);
  const items = useListItemActions({ onSaved: view.refresh, onRemoved: view.refetch });

  // Retire each pending tick as the projection catches up with it, and never before.
  useEffect(() => {
    setChecks((current) => settleOverrides(current, view.items));
  }, [view.items]);

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
        ) : list === undefined ? null : (
          <View testID="list-detail-items">
            {/*
             * The row is handed the list's own `behaviour` and `capabilities` and nothing
             * else — not the title, not the template key. That narrowing is the whole of
             * ADR-032 at the call site (P3-28).
             */}
            {view.items.map((item) => (
              <ListItemRow
                key={item.itemId}
                list={list}
                item={{ ...item, checked: isChecked(item, checks) }}
                onOpen={() => setOpenItemId(item.itemId)}
                onToggleChecked={(next) => {
                  setChecks((current) => withOverride(current, item.itemId, next));
                  void items.save(item, { checked: next }).then((saved) => {
                    // A refused tick goes back to committed truth; §5.3's toast is the hook's.
                    if (!saved) {
                      setChecks((current) => withoutOverride(current, item.itemId));
                    }
                  });
                }}
                onOpenLocation={() => void openInMaps(item.location)}
                testID={`list-item-${item.itemId}`}
              />
            ))}
          </View>
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
