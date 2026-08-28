import { FIRST_RANK, lexoRankBetween } from '../rank/index.js';
import { instant } from '../schemas/common.js';
import type {
  ItemStateMode,
  List,
  ListFeatureConfig,
  ListItem,
  ListItemFeatures,
  ListItemState,
  ListPlace,
  ProgressValue,
} from '../types/list.js';

type OldShapeKind = 'collection' | 'watch' | 'meals';

interface OldList {
  listId: string;
  ownerId: List['ownerId'];
  behaviour: OldShapeKind;
  templateKey: string;
  title: string;
  icon: string;
  emptyStateCopy: string;
  capabilities: { checkable: boolean; supportsLocation: boolean };
  slot: List['slot'];
  sourceActivityId?: string;
  itemCount: number;
  uncheckedCount: number;
  memberCount: number;
  rankVersion: number;
  itemVersion?: number;
  rankRepairId?: string;
  archived: boolean;
  updatedAt: string;
  lastItemActivityAt: string;
}

interface OldIngredient {
  ingredientId: string;
  name: string;
  quantity?: string;
  addedToListId?: string;
}

type OldItemDetails =
  | {
      behaviour: 'watch';
      mediaKind?: 'movie' | 'show';
      watchStatus: 'want' | 'watching' | 'watched';
      season?: number;
      episode?: number;
    }
  | { behaviour: 'meals'; ingredients?: OldIngredient[] };

const LEGACY_WATCH_STATE = {
  want: 'open',
  watching: 'active',
  watched: 'done',
} satisfies Record<
  Extract<OldItemDetails, { behaviour: 'watch' }>['watchStatus'],
  ListItemState
>;

interface OldItem {
  itemId: string;
  listId: string;
  rank: string;
  itemRevision: number;
  title: string;
  note?: string;
  checked: boolean;
  location?: ListPlace;
  sourceActivityId?: string;
  sourceLabel?: string;
  sourceProvenance?: { activityId: string; label: string }[];
  details?: OldItemDetails;
}

export type LegacyListAggregate = { list: OldList; items: OldItem[] };
export interface ListAggregate {
  list: List;
  items: ListItem[];
}

/**
 * Pure, deterministic conversion used by server and SQLite migration fixtures.
 * `schemaVersion` is the idempotency fence: a converted aggregate is returned unchanged.
 */
export function migrateLegacyListAggregate(
  aggregate: LegacyListAggregate | ListAggregate,
): ListAggregate {
  if (isCurrentAggregate(aggregate)) {
    return aggregate;
  }

  const { list: oldList } = aggregate;
  const items = aggregate.items.map((item) => migrateItem(oldList.behaviour, item));
  const doneCount = items.filter((item) => item.state === 'done').length;
  const {
    behaviour: _behaviour,
    capabilities: _capabilities,
    uncheckedCount: _unchecked,
    ...retained
  } = oldList;

  return {
    list: {
      ...retained,
      schemaVersion: 2,
      itemStateMode: stateModeFor(oldList),
      featureConfig: featureConfigFor(oldList),
      doneCount,
      rankVersion: oldList.rankVersion + 1,
      updatedAt: instant.parse(oldList.updatedAt),
      lastItemActivityAt: instant.parse(oldList.lastItemActivityAt),
    },
    items,
  };
}

function isCurrentAggregate(
  aggregate: LegacyListAggregate | ListAggregate,
): aggregate is ListAggregate {
  return 'schemaVersion' in aggregate.list && aggregate.list.schemaVersion === 2;
}

function stateModeFor(list: OldList): ItemStateMode {
  if (list.behaviour === 'watch') {
    return {
      mode: 'stages',
      labels: { open: 'Want to watch', active: 'Watching', done: 'Watched' },
      groupByState: true,
    };
  }
  if (list.behaviour === 'meals') return { mode: 'none' };
  return list.capabilities.checkable ? { mode: 'checkbox' } : { mode: 'none' };
}

function featureConfigFor(list: OldList): ListFeatureConfig {
  if (list.behaviour === 'watch') {
    return { progress: { enabled: true, kind: 'episode' } };
  }
  if (list.behaviour === 'meals') {
    return {
      subItems: {
        enabled: true,
        sectionLabel: 'Ingredients',
        singularLabel: 'Ingredient',
        secondaryLabel: 'Quantity',
        integration: 'mealIngredients',
      },
    };
  }
  return list.capabilities.supportsLocation ? { place: { enabled: true } } : {};
}

function migrateItem(kind: OldShapeKind, item: OldItem): ListItem {
  const { checked: _checked, location, details, ...retained } = item;
  const features: ListItemFeatures = {};
  let state: ListItemState = item.checked ? 'done' : 'open';

  if (location !== undefined) features.place = { ...location };
  if (kind === 'watch' && details?.behaviour === 'watch') {
    state = LEGACY_WATCH_STATE[details.watchStatus];
    const progress = episodeProgress(details);
    if (progress !== undefined) features.progress = progress;
  }
  if (
    kind === 'meals' &&
    details?.behaviour === 'meals' &&
    details.ingredients !== undefined
  ) {
    let previous: string | undefined;
    features.subItems = {
      entries: details.ingredients.map((ingredient) => {
        const rank = previous === undefined ? FIRST_RANK : lexoRankBetween(previous);
        previous = rank;
        return {
          id: deterministicSubItemId(ingredient.ingredientId),
          title: ingredient.name,
          ...(ingredient.quantity === undefined
            ? {}
            : { secondary: ingredient.quantity }),
          rank,
        };
      }),
    };
  }

  return {
    ...retained,
    state,
    ...(Object.keys(features).length === 0 ? {} : { features }),
  };
}

function episodeProgress(
  details: Extract<OldItemDetails, { behaviour: 'watch' }>,
): ProgressValue | undefined {
  if (
    details.mediaKind === undefined &&
    details.season === undefined &&
    details.episode === undefined
  ) {
    return undefined;
  }
  return {
    kind: 'episode',
    ...(details.mediaKind === undefined ? {} : { mediaKind: details.mediaKind }),
    ...(details.season === undefined ? {} : { season: details.season }),
    ...(details.episode === undefined ? {} : { episode: details.episode }),
  };
}

function deterministicSubItemId(ingredientId: string): string {
  return `sub_${ingredientId.startsWith('ing_') ? ingredientId.slice(4) : ingredientId}`;
}
