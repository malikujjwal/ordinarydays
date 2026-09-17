import type { UserId } from '../schemas/common.js';
import type { Instant } from '../time/index.js';
import type { DefaultSlot } from './user.js';

/** Intrinsic item state. Presentation is selected by the owning List. */
export type ListItemState = 'open' | 'active' | 'done';

export interface StageLabels {
  open: string;
  active: string;
  done: string;
}

export type ItemStateMode =
  | { mode: 'none' }
  | { mode: 'checkbox' }
  | { mode: 'stages'; labels: StageLabels; groupByState: boolean };

export type ProgressValue =
  | { kind: 'text'; value: string }
  | {
      kind: 'episode';
      mediaKind?: 'movie' | 'show';
      season?: number;
      episode?: number;
    };

export interface ListSubItem {
  id: string;
  title: string;
  secondary?: string;
  rank: string;
}

export interface ListPlace {
  label: string;
  address?: string;
  lat?: number;
  lng?: number;
}

export interface ListItemFeatures {
  progress?: ProgressValue;
  place?: ListPlace;
  subItems?: { entries: ListSubItem[] };
}

export interface ProgressFeatureConfig {
  enabled: boolean;
  kind: 'text' | 'episode';
}

export interface PlaceFeatureConfig {
  enabled: boolean;
}

export interface SubItemsFeatureConfig {
  enabled: boolean;
  sectionLabel: string;
  singularLabel: string;
  secondaryLabel?: string;
  integration?: 'mealIngredients';
}

/** Keyed so a feature can occur at most once and each PATCH path is stable. */
export interface ListFeatureConfig {
  progress?: ProgressFeatureConfig;
  place?: PlaceFeatureConfig;
  subItems?: SubItemsFeatureConfig;
}

/**
 * What a List can be a destination for, derived from `itemStateMode`/`featureConfig` and
 * never stored — `packages/shared/src/lists/ingredientDestination.ts` is the one place that
 * computes it. Optional on `List` because it exists only on a response the API has shaped
 * (`services/api/src/handlers/toList.ts`); a row read from storage or from the native
 * projection carries the fields it is derived from instead.
 */
export interface ListCapabilities {
  ingredients: boolean;
}

/**
 * One `(activityId, ingredientId)` pair a `ListItem` currently answers for (Option B,
 * 2026-09-16). Flattened from `sourceProvenance` at response time — `origins` never exposes
 * a segment's rendered `label` — by the one function that does it,
 * `packages/shared/src/lists/itemOrigin.ts`'s `originsFromProvenance`.
 */
export interface ItemOrigin {
  activityId: string;
  ingredientId: string;
}

/** One List model. `templateKey` is immutable creation provenance only. */
export interface List {
  schemaVersion: 2;
  listId: string;
  ownerId: UserId;
  templateKey: string;
  title: string;
  icon: string;
  emptyStateCopy: string;
  itemStateMode: ItemStateMode;
  featureConfig: ListFeatureConfig;
  slot: DefaultSlot | null;
  capabilities?: ListCapabilities;
  sourceActivityId?: string;
  itemCount: number;
  doneCount: number;
  memberCount: number;
  rankVersion: number;
  itemVersion?: number;
  rankRepairId?: string;
  /** Storage-only aggregate conversion fence. Never serialized. */
  schemaMigrationId?: string;
  archived: boolean;
  updatedAt: Instant;
  lastItemActivityAt: Instant;
}

export interface ListIndex {
  listId: string;
  userId: UserId;
  role: 'owner' | 'member';
  addedAt: string;
}

export interface ListMember {
  listId: string;
  personId: string;
  userId?: UserId;
  reciprocalPersonId?: string;
  displayName: string;
  email?: string;
  role: 'member';
  status: 'invited' | 'active';
  invitedBy: UserId;
  addedAt: string;
  joinedAt?: string;
}

export interface ListItem {
  itemId: string;
  listId: string;
  rank: string;
  itemRevision: number;
  title: string;
  note?: string;
  state: ListItemState;
  features?: ListItemFeatures;
  sourceActivityId?: string;
  sourceLabel?: string;
  /** `ingredientIds` is optional: a segment written before Option B (2026-09-16) has none. */
  sourceProvenance?: { activityId: string; label: string; ingredientIds?: string[] }[];
  /**
   * Which meal ingredient(s) this row currently answers for, derived from `sourceProvenance`
   * and never itself stored — optional for the same reason `List.capabilities` is: it exists
   * only on a response the API has shaped (`toListItem`) or a native projection that derived
   * it the same way. `itemOriginatesFrom` is the one predicate that reads it.
   */
  origins?: ItemOrigin[];
}

export interface ListItemActivityLink {
  listId: string;
  itemId: string;
  viewerUserId: UserId;
  activityId: string;
  linkedAt: string;
}

/** A creation preset copied into the List. It is never a live reference. */
export interface ListTemplate {
  templateKey: string;
  chooserLabel: string;
  summary: string;
  defaultTitle: string;
  icon: string;
  itemStateMode: ItemStateMode;
  featureConfig: ListFeatureConfig;
  slot: DefaultSlot | null;
  emptyStateCopy: string;
}
