import type { ActivityLocation } from '../types/activity.js';
import type { List, ListItem } from '../types/list.js';

export type ExplicitPlanKind = 'general' | 'meal' | 'watch' | 'event';

export type ListItemPlanDraft =
  | { kind: 'general'; title: string; notes?: string }
  | {
      kind: 'meal';
      title: string;
      notes?: string;
      ingredients?: { sourceSubItemId: string; name: string; quantity?: string }[];
    }
  | {
      kind: 'watch';
      title: string;
      notes?: string;
      progress?: { mediaKind?: 'movie' | 'show'; season?: number; episode?: number };
    }
  | { kind: 'event'; title: string; notes?: string; location?: ActivityLocation };

/** One-time copy selected only by the explicit Plan kind. No label, template, or slot inference. */
export function adaptListItemToPlan(
  list: Pick<List, 'featureConfig'>,
  item: Pick<ListItem, 'title' | 'note' | 'features'>,
  kind: ExplicitPlanKind,
): ListItemPlanDraft {
  const common = {
    title: item.title,
    ...(item.note === undefined ? {} : { notes: item.note }),
  };
  if (kind === 'general') return { kind, ...common };
  if (kind === 'meal') {
    const config = list.featureConfig.subItems;
    const entries = item.features?.subItems?.entries;
    const ingredients =
      config?.enabled === true &&
      config.integration === 'mealIngredients' &&
      entries !== undefined
        ? entries.map((entry) => ({
            sourceSubItemId: entry.id,
            name: entry.title,
            ...(entry.secondary === undefined ? {} : { quantity: entry.secondary }),
          }))
        : undefined;
    return { kind, ...common, ...(ingredients === undefined ? {} : { ingredients }) };
  }
  if (kind === 'watch') {
    const config = list.featureConfig.progress;
    const progress = item.features?.progress;
    if (
      config?.enabled !== true ||
      config.kind !== 'episode' ||
      progress?.kind !== 'episode'
    ) {
      return { kind, ...common };
    }
    const { kind: _valueKind, ...episode } = progress;
    return { kind, ...common, progress: episode };
  }
  const place =
    list.featureConfig.place?.enabled === true ? item.features?.place : undefined;
  return { kind, ...common, ...(place === undefined ? {} : { location: { ...place } }) };
}
