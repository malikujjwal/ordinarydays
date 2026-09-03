import type { Instant } from '@od/shared/time';
import type { List } from '@od/shared/types';
import {
  EmptyState,
  IconButton,
  MoreHorizontal,
  SectionHeader,
  Skeleton,
  space,
  Text,
  Touchable,
  useTheme,
} from '@od/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { ConnectivityStatus } from '@/components/ConnectivityStatus';
import { TabScreen } from '@/components/TabScreen';
import { useLists } from '../hooks/useLists';
import { useSettledNavigation } from '../hooks/useSettledNavigation';
import { archivedListToast } from '../model/archiveUndoToast';
import { deleteListConfirmation } from '../model/deleteConfirmation';
import {
  mayShowEmptyState,
  partitionByArchived,
  shouldDrainMore,
} from '../model/indexDrain';
import { leaveListConfirmation } from '../model/leaveConfirmation';
import {
  type ListSwipeAction,
  listSwipeActions,
  roleFor,
} from '../model/listSwipeActions';
import { ListCardGrid } from './ListCardGrid';
import { ListIndexMenu } from './ListIndexMenu';
import { ListsIndexScroll } from './ListsIndexScroll';
import { SwipeableListCard } from './SwipeableListCard';

/**
 * The Lists tab (`plans-and-lists.md` §5.6, §5.9, `design-system.md` §7.2, §P3-25).
 *
 * ## `Show archived` is a filter, never a second request
 *
 * `GET /v1/lists` pages **every** access pointer, archived included, and does not filter. So
 * both groups come from one materialized set: toggling reuses pages already loaded and only
 * then continues the same bounded drain. A second endpoint would mean two cursors over one
 * order, and an archived list restored on another device would appear in neither until both
 * happened to refresh.
 *
 * ## Filtering is not pagination completion
 *
 * This is the rule the screen exists to get right. A page can contribute **zero visible rows
 * and still have a cursor** — fifty archived pointers first, active lists behind them. So the
 * drain keeps asking while the *active filtered view* cannot fill the viewport and a cursor
 * remains, and `No lists yet` is legal only after the cursor is exhausted. The decisions live
 * in `model/indexDrain.ts` so they can be tested without a viewport; what lives here is the
 * scheduling, one page per effect, never a loop.
 */

/** Roughly how many cards fill a screen. The drain's floor — never a page size. */
const VIEWPORT_ROWS = 8;

/** Auto-fetch at 80 % scroll depth (`interaction-contract.md` §5.1). */
const SCROLL_FETCH_RATIO = 0.8;

export interface ListsScreenProps {
  /** The clock, read at the route. §4.3 keeps `new Date()` out of anything testable. */
  now: Instant;
  /** Signed-in user, for the owner/member swipe branch. Undefined before `me` resolves. */
  viewerUserId?: string;
  onOpenList: (listId: string) => void;
  /** Opens P3-26's creation sheet. This screen creates nothing. */
  onNewList: () => void;
  onArchive: (list: List) => void;
  onRestore: (list: List) => void;
  onDelete: (list: List) => void;
  /** Phase 6 supplies the self-membership DELETE. Until then member actions stay hidden. */
  onLeave?: (list: List) => void;
}

export function ListsScreen({
  now,
  viewerUserId,
  onOpenList,
  onNewList,
  onArchive,
  onRestore,
  onDelete,
  onLeave,
}: ListsScreenProps) {
  const theme = useTheme();
  const view = useLists();
  const effectiveViewerUserId = viewerUserId ?? view.viewerUserId;
  const [menuOpen, setMenuOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const openList = useSettledNavigation(onOpenList);
  const [pendingDestructive, setPendingDestructive] = useState<
    { readonly list: List; readonly action: 'delete' | 'leave' } | undefined
  >(undefined);

  const { active, archived } = useMemo(
    () => partitionByArchived(view.lists),
    [view.lists],
  );

  /**
   * The drain, scheduled rather than looped.
   *
   * One page per effect run: the page lands, the effect re-runs on the new count, and it asks
   * again only if the filtered view still cannot fill. §P3-25 requires the synchronous work per
   * render cycle to be bounded, and a `while` here would be precisely the thing it forbids — a
   * hundred archived pointers would page the whole account inside one commit.
   *
   */
  // A zero sentinel keeps Show archived draining until that group is discoverable.
  const autoDrainVisibleCount =
    showArchived && archived.length === 0
      ? 0
      : showArchived
        ? active.length + archived.length
        : active.length;

  useEffect(() => {
    if (
      shouldDrainMore({
        visibleCount: autoDrainVisibleCount,
        viewportRows: VIEWPORT_ROWS,
        hasMore: view.hasMore,
        isFetching: view.isLoadingMore,
      })
    ) {
      view.loadMore();
    }
  }, [autoDrainVisibleCount, view.hasMore, view.isLoadingMore, view.loadMore]);

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
      if (depth >= SCROLL_FETCH_RATIO) view.loadMore();
    },
    [view.loadMore],
  );

  const dispatch = useCallback(
    (list: List, action: ListSwipeAction) => {
      if (action.name === 'archive') onArchive(list);
      // Destructive actions never act from the gesture: §1a.1's dialog is the commit point.
      if (
        action.name === 'delete' ||
        (action.name === 'leave' && onLeave !== undefined)
      ) {
        setPendingDestructive({ list, action: action.name });
      }
    },
    [onArchive, onLeave],
  );

  const showEmpty =
    mayShowEmptyState({
      visibleCount: active.length,
      hasMore: view.hasMore,
      isFetching: view.isLoadingMore,
      hasLoadedOnce: view.status !== 'pending',
    }) && view.status !== 'error';

  const renderCard = (list: List, dimmed: boolean) => (
    <View key={list.listId}>
      <SwipeableListCard
        list={list}
        now={now}
        timezone={view.timezone}
        onPress={() => openList(list.listId)}
        dimmed={dimmed}
        testID={`list-card-${list.listId}`}
        actions={
          dimmed || effectiveViewerUserId === undefined
            ? []
            : roleFor(list, effectiveViewerUserId) === 'member' && onLeave === undefined
              ? []
              : listSwipeActions(roleFor(list, effectiveViewerUserId))
        }
        onAction={(action) => dispatch(list, action)}
      />
      {dimmed ? (
        /* One tap to restore, per §5.6. The archived card itself stays inert. */
        <Touchable
          accessibilityRole="button"
          accessibilityLabel={`Restore ${list.title}`}
          onPress={() => onRestore(list)}
          testID={`list-restore-${list.listId}`}
          style={styles.restoreAction}
        >
          <Text variant="footnoteStrong" color="textAction">
            Restore
          </Text>
        </Touchable>
      ) : null}
    </View>
  );

  return (
    <TabScreen
      title="Lists"
      caption={`${String(active.length)} ${active.length === 1 ? 'LIST' : 'LISTS'}`}
      testID="lists-screen"
      bleedBody
      titleAccessory={<ConnectivityStatus />}
      headerAction={
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space[3] }}>
          {/* `+ New list` is a text action in the header, not a FAB (§7.2). */}
          <Touchable
            accessibilityRole="button"
            accessibilityLabel="New list"
            onPress={onNewList}
            testID="lists-new"
          >
            <Text variant="footnoteStrong" color="textAction">
              + New list
            </Text>
          </Touchable>
          <IconButton
            icon={MoreHorizontal}
            label="More"
            onPress={() => setMenuOpen(true)}
            testID="lists-menu"
          />
        </View>
      }
    >
      <ListsIndexScroll
        onScroll={onScroll}
        scrollEventThrottle={16}
        testID="lists-scroll"
      >
        {/*
          Connectivity and refresh state live in the header's cloud glyph (founder,
          2026-08-31): an inline line above the rows reflowed the whole screen every time it
          appeared. With nothing to keep, the screen itself is still the error and offers
          `Try again` — §5.3's empty-failure class is unchanged.
        */}
        {view.status === 'error' && view.lists.length === 0 ? (
          <View testID="lists-error">
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
                testID="lists-error-request-id"
              >
                {view.requestId}
              </Text>
            )}
          </View>
        ) : null}

        {view.status === 'pending' ? (
          <View testID="lists-loading" style={{ paddingTop: theme.space[5] }}>
            <Skeleton shape="row" count={5} />
          </View>
        ) : showEmpty ? (
          /* §5.9, verbatim. `No lists yet` states literal absence, which §5.2 allows. */
          <EmptyState
            heading="No lists yet"
            body="Keep things you want to remember, track, or organise together."
            action={{ label: 'New list', onPress: onNewList }}
            testID="lists-empty"
          />
        ) : (
          <View style={{ marginTop: theme.space[8] }}>
            <SectionHeader title="Recent" count={active.length} variant="sectionLabel" />
            <ListCardGrid>{active.map((list) => renderCard(list, false))}</ListCardGrid>
          </View>
        )}

        {showArchived && archived.length > 0 ? (
          <View
            testID="lists-archived-section"
            style={{
              gap: theme.space[2],
              marginTop: theme.space[5],
              paddingTop: theme.space[5],
              borderTopWidth: 1,
              borderTopColor: theme.colors.borderStrong,
            }}
          >
            <SectionHeader title="Archived" count={archived.length} />
            <ListCardGrid>{archived.map((list) => renderCard(list, true))}</ListCardGrid>
          </View>
        ) : null}
      </ListsIndexScroll>

      <ListIndexMenu
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        showingArchived={showArchived}
        archivedCount={archived.length}
        onToggleArchived={() => {
          setShowArchived((current) => !current);
          setMenuOpen(false);
        }}
      />

      {pendingDestructive === undefined ? null : (
        <ConfirmDialog
          centred={pendingDestructive.action === 'delete'}
          open
          confirmation={
            pendingDestructive.action === 'delete'
              ? deleteListConfirmation(pendingDestructive.list)
              : leaveListConfirmation(pendingDestructive.list)
          }
          onCancel={() => setPendingDestructive(undefined)}
          onConfirm={() => {
            if (pendingDestructive.action === 'delete') {
              onDelete(pendingDestructive.list);
            } else {
              onLeave?.(pendingDestructive.list);
            }
            setPendingDestructive(undefined);
          }}
          testID="list-delete-confirm"
        />
      )}
    </TabScreen>
  );
}

/** Re-exported for the route, which assembles the archive toast around the mutation. */
export { archivedListToast };

const styles = StyleSheet.create({
  restoreAction: {
    paddingHorizontal: space[4],
  },
});
