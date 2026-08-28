import type { PatchListItemInput } from '@od/shared/client';
import { FIRST_RANK, lexoRankBetween } from '@od/shared/rank';
import type {
  List,
  ListItemFeatures,
  ListItemView,
  ListPlace,
  ListSubItem,
  ProgressValue,
} from '@od/shared/types';
import { featureEnabled } from './featureRegistry';

export type RowList = Pick<List, 'itemStateMode' | 'featureConfig'>;

export interface ItemSheetFieldSet {
  readonly progress: boolean;
  readonly place: boolean;
  readonly subItems: boolean;
}

export function itemSheetFields(list: RowList): ItemSheetFieldSet {
  return {
    progress: featureEnabled('progress', list.featureConfig),
    place: featureEnabled('place', list.featureConfig),
    subItems: featureEnabled('subItems', list.featureConfig),
  };
}

export function moveSubItem(
  entries: readonly ListSubItem[],
  from: number,
  to: number,
): readonly ListSubItem[] {
  if (
    from < 0 ||
    from >= entries.length ||
    to < 0 ||
    to >= entries.length ||
    from === to
  ) {
    return entries;
  }
  const reordered = [...entries];
  const [moved] = reordered.splice(from, 1);
  if (moved === undefined) return entries;
  reordered.splice(to, 0, moved);
  let previous: string | undefined;
  return reordered.map((entry) => {
    const rank = previous === undefined ? FIRST_RANK : lexoRankBetween(previous);
    previous = rank;
    return { ...entry, rank };
  });
}

export interface ItemProvenance {
  readonly label: string;
  readonly sourceActivityId?: string;
}

export function itemProvenance(item: ListItemView): ItemProvenance | undefined {
  if (item.sourceLabel === undefined) return undefined;
  return {
    label: item.sourceLabel,
    ...(item.sourceActivityId === undefined
      ? {}
      : { sourceActivityId: item.sourceActivityId }),
  };
}

export function provenanceLine(value: ItemProvenance): string {
  return `From ${value.label}`;
}

export function titlePatch(
  item: ListItemView,
  next: string,
): PatchListItemInput | undefined {
  const title = next.trim();
  return title === '' || title === item.title ? undefined : { title };
}

export function notePatch(
  item: ListItemView,
  next: string,
): PatchListItemInput | undefined {
  const note = next.trim();
  if (note === (item.note ?? '')) return undefined;
  return { note: note === '' ? null : note };
}

function featuresPatch(
  item: ListItemView,
  key: keyof ListItemFeatures,
  value: ListItemFeatures[typeof key] | undefined,
): PatchListItemInput | undefined {
  if (JSON.stringify(value) === JSON.stringify(item.features?.[key])) return undefined;
  return { features: { [key]: value ?? null } };
}

export function placePatch(
  item: ListItemView,
  label: string,
  address: string,
): PatchListItemInput | undefined {
  const trimmedLabel = label.trim();
  const trimmedAddress = address.trim();
  if (trimmedLabel === '') return featuresPatch(item, 'place', undefined);
  const current = item.features?.place;
  const next: ListPlace = {
    label: trimmedLabel,
    ...(trimmedAddress === '' ? {} : { address: trimmedAddress }),
    ...(current?.lat === undefined ? {} : { lat: current.lat }),
    ...(current?.lng === undefined ? {} : { lng: current.lng }),
  };
  return featuresPatch(item, 'place', next);
}

export function progressPatch(
  item: ListItemView,
  progress: ProgressValue | undefined,
): PatchListItemInput | undefined {
  return featuresPatch(item, 'progress', progress);
}

export function subItemsPatch(
  item: ListItemView,
  entries: readonly ListSubItem[],
): PatchListItemInput | undefined {
  return featuresPatch(item, 'subItems', { entries: [...entries] });
}

export function appendSubItem(
  entries: readonly ListSubItem[],
  id: string,
): readonly ListSubItem[] {
  const previous = entries.at(-1)?.rank;
  return [
    ...entries,
    {
      id,
      title: '',
      rank: previous === undefined ? FIRST_RANK : lexoRankBetween(previous),
    },
  ];
}

export function itemNumber(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === '' || !/^\d+$/.test(trimmed)) return undefined;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
