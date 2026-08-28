import type {
  DefaultSlot,
  ItemStateMode,
  List,
  ListFeatureConfig,
} from '@od/shared/types';

export type PendingListSettings = Partial<
  Pick<List, 'title' | 'itemStateMode' | 'featureConfig' | 'slot' | 'archived'>
>;

export const STATE_MODE_LABELS = {
  none: 'None',
  checkbox: 'Checkboxes',
  stages: 'Stages',
} as const;

export const SLOT_LABELS: Record<DefaultSlot, string> = {
  groceries: 'Groceries',
  watch: 'Watch later',
  meals: 'Meal ideas',
};
export const SLOT_MEANINGS: Record<DefaultSlot, string> = {
  groceries: 'Receive ingredients sent from meal plans.',
  watch: 'Receive things you plan to watch.',
  meals: 'Receive meal ideas.',
};
export const NO_SLOT_LABEL = 'Not a default';
export const SLOT_CLEARS_PROFILE_DEFAULT =
  'Choosing a different default replaces the current one for that destination.';

export function withPendingSettings(
  list: List,
  pending: PendingListSettings | undefined,
): List {
  return pending === undefined ? list : { ...list, ...pending };
}

export function withoutPendingSettings(
  current: PendingListSettings | undefined,
  drop: PendingListSettings,
): PendingListSettings | undefined {
  if (current === undefined) return undefined;
  const next = { ...current };
  for (const key of Object.keys(drop) as (keyof PendingListSettings)[]) delete next[key];
  return Object.keys(next).length === 0 ? undefined : next;
}

export function settlePendingSettings(
  pending: PendingListSettings | undefined,
  committed: List | undefined,
): PendingListSettings | undefined {
  if (pending === undefined || committed === undefined) return pending;
  const next = { ...pending };
  for (const key of Object.keys(pending) as (keyof PendingListSettings)[]) {
    if (JSON.stringify(pending[key]) === JSON.stringify(committed[key])) delete next[key];
  }
  return Object.keys(next).length === 0 ? undefined : next;
}

export function mergedFeatureConfig(
  list: List,
  patch: Partial<ListFeatureConfig>,
): ListFeatureConfig {
  return { ...list.featureConfig, ...patch } as ListFeatureConfig;
}

export function stageMode(
  labels?: Partial<Extract<ItemStateMode, { mode: 'stages' }>>,
): ItemStateMode {
  return {
    mode: 'stages',
    labels:
      'labels' in (labels ?? {}) && labels?.labels !== undefined
        ? labels.labels
        : { open: 'Saved', active: 'In progress', done: 'Done' },
    groupByState:
      'groupByState' in (labels ?? {}) ? labels?.groupByState === true : false,
  };
}
