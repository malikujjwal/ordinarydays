import {
  adaptListItemToPlan,
  type ExplicitPlanKind,
  type ListItemPlanDraft,
} from '@od/shared/lists';
import type { List, ListItemFeatures, ListItemState, PlanType } from '@od/shared/types';
import {
  type DraftDetails,
  type DraftLocation,
  EMPTY_LOCATION,
} from '@/features/compose/model/draft';

/**
 * The `Plan this item` bridge source (P3-34).
 *
 * Everything the compose flow needs to pre-fill a Plan-kind form from one list item, carried
 * into the draft store when the sheet opens and dropped on reset. It is a **copy source**,
 * never an authority: nothing in it can choose the Plan kind, the audience, or the save
 * action, and the store has no code path from these values to `target`.
 *
 * `item.state` rides along for exactly one offer: an `active` item with structured episode
 * progress may offer the *next* episode after the user has explicitly chosen Watch
 * (§P3-34 — "an item in intrinsic state `active` at S2 E4 may offer S2 E5"). The offer fills
 * a visible, editable field; it does not select Watch and does not exist in any other kind's
 * form.
 */
export interface BridgeSource {
  readonly listId: string;
  readonly itemId: string;
  readonly list: Pick<List, 'featureConfig'>;
  readonly item: {
    readonly title: string;
    readonly note?: string;
    readonly features?: ListItemFeatures;
    readonly state: ListItemState;
  };
}

/** The chosen Plan kind names the adapter; `custom` is what the explicit General tap stores. */
export function explicitKindFor(type: PlanType): ExplicitPlanKind {
  if (type === 'custom') return 'general';
  return type;
}

export interface BridgePrefill {
  readonly title: string;
  readonly notes: string;
  readonly details: Partial<DraftDetails>;
  readonly location: DraftLocation;
}

function watchDetails(
  draft: Extract<ListItemPlanDraft, { kind: 'watch' }>,
  state: ListItemState,
): Partial<DraftDetails> {
  const progress = draft.progress;
  if (progress === undefined) return {};
  const offeredEpisode =
    progress.episode !== undefined && state === 'active'
      ? progress.episode + 1
      : progress.episode;
  return {
    ...(progress.mediaKind === undefined ? {} : { mediaKind: progress.mediaKind }),
    ...(progress.season === undefined ? {} : { season: String(progress.season) }),
    ...(offeredEpisode === undefined ? {} : { episode: String(offeredEpisode) }),
  };
}

/**
 * The one-time copy for the form the explicit kind choice opens.
 *
 * A thin view over the shared adapter: the adapter decides *what* is compatible (the enabled
 * configuration ∩ populated values, §P3-33), and this maps its typed result onto the draft's
 * string-backed fields. No branch here reads `templateKey`, a slot, or the item's words.
 */
export function bridgePrefill(bridge: BridgeSource, type: PlanType): BridgePrefill {
  const draft = adaptListItemToPlan(bridge.list, bridge.item, explicitKindFor(type));
  const common = { title: draft.title, notes: draft.notes ?? '' };
  if (draft.kind === 'meal') {
    return {
      ...common,
      details: {
        ...(draft.ingredients === undefined
          ? {}
          : {
              ingredients: draft.ingredients.map((row) => ({
                id: row.sourceSubItemId,
                name: row.name,
                quantity: row.quantity ?? '',
                selected: false,
              })),
            }),
      },
      location: EMPTY_LOCATION,
    };
  }
  if (draft.kind === 'watch') {
    return {
      ...common,
      details: watchDetails(draft, bridge.item.state),
      location: EMPTY_LOCATION,
    };
  }
  if (draft.kind === 'event') {
    return {
      ...common,
      details: {},
      location:
        draft.location === undefined
          ? EMPTY_LOCATION
          : { label: draft.location.label, address: draft.location.address ?? '' },
    };
  }
  return { ...common, details: {}, location: EMPTY_LOCATION };
}
