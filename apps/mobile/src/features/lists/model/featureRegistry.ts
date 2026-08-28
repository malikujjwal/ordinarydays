import type {
  ListFeatureConfig,
  ListItemFeatures,
  ListPlace,
  ListSubItem,
  PlaceFeatureConfig,
  ProgressFeatureConfig,
  ProgressValue,
  SubItemsFeatureConfig,
} from '@od/shared/types';

export type ListItemFeatureKey = keyof ListFeatureConfig & keyof ListItemFeatures;

interface FeatureDefinition<K extends ListItemFeatureKey> {
  readonly key: K;
  readonly label: string;
  readonly enabled: (config: ListFeatureConfig[K]) => boolean;
  readonly summary: (
    config: NonNullable<ListFeatureConfig[K]>,
    value: ListItemFeatures[K],
  ) => string | undefined;
  readonly spoken: (
    config: NonNullable<ListFeatureConfig[K]>,
    value: ListItemFeatures[K],
  ) => string | undefined;
  readonly editor: <R>(
    visitor: ListItemFeatureEditorVisitor<R>,
    config: NonNullable<ListFeatureConfig[K]>,
    value: ListItemFeatures[K],
  ) => R;
}

/** UI-owned render functions visited in the registry's stable feature order. */
export interface ListItemFeatureEditorVisitor<R> {
  readonly progress: (
    config: ProgressFeatureConfig,
    value: ProgressValue | undefined,
  ) => R;
  readonly place: (config: PlaceFeatureConfig, value: ListPlace | undefined) => R;
  readonly subItems: (
    config: SubItemsFeatureConfig,
    value: ListItemFeatures['subItems'],
  ) => R;
}

function progressSummary(value: ProgressValue | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.kind === 'text') return value.value.trim() || undefined;
  const parts = [
    value.season === undefined ? undefined : `S${String(value.season)}`,
    value.episode === undefined ? undefined : `E${String(value.episode)}`,
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? undefined : parts.join(' ');
}

function progressSpoken(value: ProgressValue | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.kind === 'text') return value.value.trim() || undefined;
  const parts = [
    value.season === undefined ? undefined : `season ${String(value.season)}`,
    value.episode === undefined ? undefined : `episode ${String(value.episode)}`,
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? undefined : parts.join(' ');
}

function placeSummary(value: ListPlace | undefined): string | undefined {
  return value?.address ?? value?.label;
}

function subItemSummary(
  sectionLabel: string,
  singularLabel: string,
  entries: readonly ListSubItem[] | undefined,
): string | undefined {
  const count = entries?.length ?? 0;
  return count === 0
    ? undefined
    : `${String(count)} ${count === 1 ? singularLabel : sectionLabel}`;
}

/**
 * The single ordered registry used by both the item row renderer and item editor.
 * A feature key occurs once, owns its enable gate and reads only its typed value.
 */
export const LIST_ITEM_FEATURE_REGISTRY = {
  progress: {
    key: 'progress',
    label: 'Progress',
    enabled: (config) => config?.enabled === true,
    summary: (config, value) =>
      value?.kind === config.kind ? progressSummary(value) : undefined,
    spoken: (config, value) =>
      value?.kind === config.kind ? progressSpoken(value) : undefined,
    editor: (visitor, config, value) => visitor.progress(config, value),
  },
  place: {
    key: 'place',
    label: 'Place',
    enabled: (config) => config?.enabled === true,
    summary: (_config, value) => placeSummary(value),
    spoken: (_config, value) => placeSummary(value),
    editor: (visitor, config, value) => visitor.place(config, value),
  },
  subItems: {
    key: 'subItems',
    label: 'Sub-items',
    enabled: (config) => config?.enabled === true,
    summary: (config, value) =>
      subItemSummary(config.sectionLabel, config.singularLabel, value?.entries),
    spoken: (config, value) =>
      subItemSummary(config.sectionLabel, config.singularLabel, value?.entries),
    editor: (visitor, config, value) => visitor.subItems(config, value),
  },
} satisfies { [K in ListItemFeatureKey]: FeatureDefinition<K> };

export const LIST_ITEM_FEATURE_ORDER = ['progress', 'place', 'subItems'] as const;

/**
 * Visits every enabled editor through the same registry that owns row presentation.
 * ItemSheet supplies production components; feature selection and ordering live here once.
 */
export function visitEnabledFeatureEditors<R>(
  config: ListFeatureConfig,
  values: ListItemFeatures | undefined,
  visitor: ListItemFeatureEditorVisitor<R>,
): readonly R[] {
  const rendered: R[] = [];
  const progress = config.progress;
  if (progress !== undefined && LIST_ITEM_FEATURE_REGISTRY.progress.enabled(progress)) {
    rendered.push(
      LIST_ITEM_FEATURE_REGISTRY.progress.editor(visitor, progress, values?.progress),
    );
  }
  const place = config.place;
  if (place !== undefined && LIST_ITEM_FEATURE_REGISTRY.place.enabled(place)) {
    rendered.push(LIST_ITEM_FEATURE_REGISTRY.place.editor(visitor, place, values?.place));
  }
  const subItems = config.subItems;
  if (subItems !== undefined && LIST_ITEM_FEATURE_REGISTRY.subItems.enabled(subItems)) {
    rendered.push(
      LIST_ITEM_FEATURE_REGISTRY.subItems.editor(visitor, subItems, values?.subItems),
    );
  }
  return rendered;
}

export function featureEnabled(
  key: ListItemFeatureKey,
  config: ListFeatureConfig,
): boolean {
  if (key === 'progress')
    return LIST_ITEM_FEATURE_REGISTRY.progress.enabled(config.progress);
  if (key === 'place') return LIST_ITEM_FEATURE_REGISTRY.place.enabled(config.place);
  return LIST_ITEM_FEATURE_REGISTRY.subItems.enabled(config.subItems);
}
