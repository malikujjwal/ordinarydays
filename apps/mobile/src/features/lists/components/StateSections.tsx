import type { List, ListItemState, ListItemView } from '@od/shared/types';
import {
  Check,
  type IconProps,
  List as ListIcon,
  PlayRect,
  SectionHeader,
  useTheme,
} from '@od/ui';
import { View } from 'react-native';
import type { ListItemRow as ListItemRowData } from '@/lib/sqlite/listItemsRepository';
import { orderedItems, type ReorderRange } from '../model/reorder';
import { ListItemRow, type ListItemRowProps } from './ListItemRow';
import { ReorderableList } from './ReorderableList';

const ORDER: readonly ListItemState[] = ['open', 'active', 'done'];
const STAGE_ICONS: Readonly<
  Record<ListItemState, (props: IconProps) => React.ReactElement>
> = {
  open: ListIcon,
  active: PlayRect,
  done: Check,
};

export type GroupedStageList = List & {
  itemStateMode: Extract<List['itemStateMode'], { mode: 'stages' }>;
};

export function isGroupedStageList(list: List): list is GroupedStageList {
  return list.itemStateMode.mode === 'stages' && list.itemStateMode.groupByState;
}

export interface StateSectionsProps {
  list: GroupedStageList;
  items: readonly ListItemRowData[];
  onOpen: (item: ListItemView) => void;
  onDrop: (itemId: string, toIndex: number) => void;
  /**
   * Per-row additions the surface derives — today the Plan state line trio and its tap
   * target (P3-35). A function rather than pre-zipped rows so this component keeps rendering
   * plain items and cannot re-derive or reinterpret the line.
   */
  rowExtras?: (item: ListItemRowData) => Partial<ListItemRowProps>;
}

export function stateGroupDropIndex(
  items: readonly ListItemView[],
  itemId: string,
  withinGroup: number,
): number | undefined {
  const sorted = orderedItems(items);
  const dragged = sorted.find((item) => item.itemId === itemId);
  if (dragged === undefined) return undefined;
  const remaining = sorted.filter((item) => item.itemId !== itemId);
  const positions = remaining.flatMap((item, at) =>
    item.state === dragged.state ? [at] : [],
  );
  if (positions.length === 0) return sorted.indexOf(dragged);
  if (withinGroup <= 0) return positions[0];
  const previous = positions[Math.min(withinGroup - 1, positions.length - 1)];
  return previous === undefined ? undefined : previous + 1;
}

/** Bounds for the section-local drag surface, never the cross-state backing array. */
export function stateGroupReorderRange(
  items: readonly ListItemView[],
  itemId: string,
): ReorderRange | undefined {
  const dragged = items.find((item) => item.itemId === itemId);
  if (dragged === undefined) return undefined;
  const sectionLength = items.filter((item) => item.state === dragged.state).length;
  return { first: 0, last: Math.max(0, sectionLength - 1) };
}

export function StateSections({
  list,
  items,
  onOpen,
  onDrop,
  rowExtras,
}: StateSectionsProps) {
  const theme = useTheme();
  return (
    <View style={{ gap: theme.space[4] }} testID="list-state-sections">
      {ORDER.map((state) => {
        const section = orderedItems(items).filter((item) => item.state === state);
        if (section.length === 0) return null;
        return (
          <View
            key={state}
            style={{ gap: theme.space[2] }}
            testID={`list-state-${state}`}
          >
            <SectionHeader
              title={list.itemStateMode.labels[state]}
              count={section.length}
              icon={STAGE_ICONS[state]}
              appearance="tinted"
              testID={`stage-heading-${state}`}
            />
            <ReorderableList
              items={section}
              keyOf={(item) => item.itemId}
              labelOf={(item) => item.title}
              rangeOf={(itemId) => stateGroupReorderRange(items, itemId)}
              handleAppearance="quiet"
              onDrop={(itemId, within) => {
                const flat = stateGroupDropIndex(items, itemId, within);
                if (flat !== undefined) onDrop(itemId, flat);
              }}
              renderItem={(item) => (
                <ListItemRow
                  list={list}
                  item={item}
                  onOpen={() => onOpen(item)}
                  {...rowExtras?.(item)}
                  testID={`list-item-${item.itemId}`}
                />
              )}
            />
          </View>
        );
      })}
    </View>
  );
}
