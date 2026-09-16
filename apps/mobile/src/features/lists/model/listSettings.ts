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

/**
 * Capability-flavoured, not slot-named (Option B1, `docs/reports/
 * destination-flow-simplification-20260916.md`): this row is the one place a slot's name
 * still reaches the user, and it now reads what the list *receives* rather than a routing
 * term. `meals` keeps an entry so an already-set list still displays correctly; it is not
 * offered as a choice — see {@link SELECTABLE_SLOTS}.
 */
export const SLOT_LABELS: Record<DefaultSlot, string> = {
  groceries: 'Ingredients from meals',
  watch: 'Things to watch',
  meals: 'Meal ideas',
};
export const SLOT_MEANINGS: Record<DefaultSlot, string> = {
  groceries: 'Receive ingredients sent from meal plans.',
  watch: 'Receive things you plan to watch.',
  meals: 'Receive meal ideas.',
};
export const NO_SLOT_LABEL = 'No default';
export const SLOT_CLEARS_PROFILE_DEFAULT =
  'Choosing a different default replaces the current one for that destination.';

/**
 * The choices the settings picker offers. `meals` is deliberately excluded: no destination
 * flow reads it today (`docs/reports/destination-flow-simplification-20260916.md` §2), so
 * offering it would let someone set a default that names nothing. A list already carrying
 * `slot: 'meals'` (a Meal Ideas list, set at creation) keeps that value and still displays it
 * via {@link SLOT_LABELS} — only the choice to set it from here is hidden.
 */
export const SELECTABLE_SLOTS: readonly DefaultSlot[] = ['groceries', 'watch'];

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
