import { SectionHeader, useTheme } from '@od/ui';
import { View } from 'react-native';
import type { ListItemRow as ListItemRowType } from '@/lib/sqlite/listItemsRepository';
import type { RowList } from '../model/listItemRow';
import type { ListSwipeAction } from '../model/listSwipeActions';
import { watchSections } from '../model/watchSections';
import { ListItemRow } from './ListItemRow';
import { ReorderableList } from './ReorderableList';
import { SwipeableWatchRow } from './SwipeableWatchRow';

/**
 * The one grouped item list in the product
 * ([`plans-and-lists.md`](../../../../../docs/01-product/plans-and-lists.md) §5.2; §P3-31).
 *
 * ```
 *  WATCHING
 *    [Watching]  Severance          S2 E4
 *  WANT TO WATCH
 *    [Want to watch]  Andor
 *  WATCHED
 *    [Watched]  Arrival
 * ```
 *
 * Three sections in a fixed order, each holding **P3-28's row** — the same renderer the flat
 * list uses, handed the same two list fields. Nothing here is a second row: a `watch` row's
 * status chip, its `S2 E4` and the absence of a checkbox are all P3-28's, and this file only
 * decides which heading a row sits under.
 *
 * ## Each section is its own drag surface
 *
 * §P3-30 constrains a drag to the item's status group, and giving each section its own
 * `ReorderableList` makes that **structural** rather than a clamp the finger discovers at the
 * edge: there is no gesture that crosses a heading, because the two headings belong to two
 * lists. `onReorder` receives a position among that group's rows and `groupDropIndex` turns it
 * back into the flat position `afterItemId` names a neighbour in — the ranks stay global and
 * interleaved, which is exactly why a status change regroups a row **at its existing rank**.
 *
 * ## What the sections do not do
 *
 * They do not renumber, do not move a changed row to the top of its new group, and add no
 * highlight. A row that becomes `watched` appears under `Watched` in its rank position and is
 * otherwise byte-identical, which falls out of projecting rather than reordering.
 */
export interface WatchSectionsProps {
  /** The list's own two fields, exactly as the flat renderer takes them (ADR-032). */
  list: RowList;
  items: readonly ListItemRowType[];
  /** §3.2's left-swipe actions for a watch row. An empty list disables the gesture. */
  actions: readonly ListSwipeAction[];
  onAction: (item: ListItemRowType, action: ListSwipeAction) => void;
  /** U1 — the body opens the item sheet, on this row as on every other (§3.2). */
  onOpen?: (item: ListItemRowType) => void;
  /** A drop **within** a section: the position among that group's rows. */
  onReorder: (itemId: string, withinGroup: number) => void;
  testID?: string;
}

export function WatchSections({
  list,
  items,
  actions,
  onAction,
  onOpen,
  onReorder,
  testID = 'watch-sections',
}: WatchSectionsProps) {
  const theme = useTheme();
  const { sections, ungrouped } = watchSections(items);

  return (
    <View style={{ gap: theme.space[5] }} testID={testID}>
      {/*
       * Invalid data, kept and unclassified. A committed `watch` row with no typed details is
       * rejected by the response schema (§P3-31); one that arrives anyway is shown rather than
       * hidden, and is never filed under a status it does not have. No heading, because there
       * is no group — P3-28's row draws its title and stops.
       */}
      {ungrouped.length === 0 ? null : (
        <View testID={`${testID}-ungrouped`}>
          {ungrouped.map((item) => (
            <ListItemRow
              key={item.itemId}
              list={list}
              item={item}
              testID={`list-item-${item.itemId}`}
            />
          ))}
        </View>
      )}

      {sections.map((section) => (
        <View key={section.status} testID={`${testID}-${section.status}`}>
          <SectionHeader
            title={section.heading}
            count={section.items.length}
            testID={`watch-heading-${section.status}`}
          />
          <ReorderableList
            items={section.items}
            keyOf={(item) => item.itemId}
            /*
             * The whole section, and only the section. `reorderRange`'s own watch clamp still
             * guards the flat path this eventually reaches; here the boundary is the surface
             * itself, so a finger cannot travel past a heading in the first place.
             */
            rangeOf={() => ({ first: 0, last: section.items.length - 1 })}
            onDrop={onReorder}
            testID={`watch-items-${section.status}`}
            renderItem={(item) => (
              <SwipeableWatchRow
                list={list}
                item={item}
                actions={actions}
                onAction={(action) => onAction(item, action)}
                {...(onOpen === undefined ? {} : { onOpen: () => onOpen(item) })}
                testID={`list-item-${item.itemId}`}
              />
            )}
          />
        </View>
      ))}
    </View>
  );
}
