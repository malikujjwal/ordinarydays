import type { List, ListItemState, ListItemView } from '@od/shared/types';
import {
  Check,
  type IconProps,
  List as ListIcon,
  PlayRect,
  Text,
  useTheme,
} from '@od/ui';
import { View } from 'react-native';
import { orderedItems, type ReorderRange } from '../model/reorder';
import { ListItemRow } from './ListItemRow';
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
  items: readonly ListItemView[];
  onOpen: (item: ListItemView) => void;
  onDrop: (itemId: string, toIndex: number) => void;
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

export function StateSections({ list, items, onOpen, onDrop }: StateSectionsProps) {
  const theme = useTheme();
  const stageAccent = theme.typeAccent('custom');
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
            <View
              testID={`stage-heading-${state}`}
              style={{
                minHeight: theme.layout.hitTarget,
                flexDirection: 'row',
                alignItems: 'center',
                gap: theme.space[2],
                paddingHorizontal: theme.space[4],
                paddingVertical: theme.space[2],
                borderRadius: theme.radius.md,
                backgroundColor: stageAccent.surface,
              }}
            >
              <View aria-hidden testID={`stage-heading-${state}-icon`}>
                {(() => {
                  const Icon = STAGE_ICONS[state];
                  return <Icon size={18} color={stageAccent.accent} />;
                })()}
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text variant="bodyStrong" color="textPrimary">
                  {list.itemStateMode.labels[state]}
                </Text>
              </View>
              <Text variant="footnoteStrong" color="textSecondary">
                {section.length}
              </Text>
            </View>
            <ReorderableList
              items={section}
              keyOf={(item) => item.itemId}
              labelOf={(item) => item.title}
              rangeOf={(itemId) => stateGroupReorderRange(items, itemId)}
              onDrop={(itemId, within) => {
                const flat = stateGroupDropIndex(items, itemId, within);
                if (flat !== undefined) onDrop(itemId, flat);
              }}
              renderItem={(item) => (
                <ListItemRow list={list} item={item} onOpen={() => onOpen(item)} />
              )}
            />
          </View>
        );
      })}
    </View>
  );
}
