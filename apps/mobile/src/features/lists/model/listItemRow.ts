import type { List, ListItemPlanState, ListItemView } from '@od/shared/types';
import { LIST_ITEM_FEATURE_REGISTRY } from './featureRegistry';

export type RowList = Pick<List, 'itemStateMode' | 'featureConfig'>;

export function showsCheckbox(list: RowList): boolean {
  return list.itemStateMode.mode === 'checkbox';
}

export function checkboxChecked(item: ListItemView): boolean {
  return item.state === 'done';
}

export function stateAfterCheckbox(
  item: ListItemView,
  checked: boolean,
): ListItemView['state'] {
  if (checked) return 'done';
  return item.state === 'done' ? 'open' : item.state;
}

export function stateLabel(list: RowList, item: ListItemView): string | undefined {
  if (list.itemStateMode.mode !== 'stages') return undefined;
  return list.itemStateMode.labels[item.state];
}

export function progressLabel(list: RowList, item: ListItemView): string | undefined {
  const config = list.featureConfig.progress;
  if (!LIST_ITEM_FEATURE_REGISTRY.progress.enabled(config) || config === undefined)
    return undefined;
  return LIST_ITEM_FEATURE_REGISTRY.progress.summary(config, item.features?.progress);
}

export function spokenProgress(list: RowList, item: ListItemView): string | undefined {
  const config = list.featureConfig.progress;
  if (!LIST_ITEM_FEATURE_REGISTRY.progress.enabled(config) || config === undefined)
    return undefined;
  return LIST_ITEM_FEATURE_REGISTRY.progress.spoken(config, item.features?.progress);
}

export function shownPlace(list: RowList, item: ListItemView) {
  return LIST_ITEM_FEATURE_REGISTRY.place.enabled(list.featureConfig.place)
    ? item.features?.place
    : undefined;
}

export function subItemCount(list: RowList, item: ListItemView): string | undefined {
  const config = list.featureConfig.subItems;
  if (!LIST_ITEM_FEATURE_REGISTRY.subItems.enabled(config) || config === undefined)
    return undefined;
  return LIST_ITEM_FEATURE_REGISTRY.subItems.summary(config, item.features?.subItems);
}

export function mayShowPlanStateLine(viewerPlan: ListItemPlanState | undefined): boolean {
  return viewerPlan?.schedule?.date !== undefined;
}

export function rowBodyLabel(list: RowList, item: ListItemView): string {
  const place = shownPlace(list, item);
  return [
    item.title,
    stateLabel(list, item)?.toLowerCase(),
    spokenProgress(list, item),
    subItemCount(list, item)?.toLowerCase(),
    place?.address ?? place?.label,
    item.sourceLabel === undefined ? undefined : `from ${item.sourceLabel}`,
  ]
    .filter((part): part is string => part !== undefined && part !== '')
    .join(', ');
}

export function checkboxLabel(item: ListItemView): string {
  return `${item.title}, ${checkboxChecked(item) ? 'checked' : 'not checked'}`;
}
