import type { UserId } from '../schemas/common.js';
import type { DefaultSlot } from './user.js';

/**
 * Lists and their items (`data-model.md` §3.3, §4.6; `plans-and-lists.md` §5).
 *
 * Lists are **independent collections**. A list that never produces an Activity is a
 * complete, finished thing, and the bridge to Activities is optional in both directions.
 * These shapes are transcribed from `data-model.md` §4.6 exactly and once; the Zod schemas
 * in `../schemas/list.ts` are the runtime check and `list.test.ts` pins the two together.
 *
 * ## Behaviour versus template — the modelling error this file exists to prevent
 *
 * **Behaviour** is what the *application* does differently: how items render, what typed
 * fields they carry, what cross-entity flows exist. It is a closed set of **three**, and the
 * test for a fourth (ADR-031) is: does the application actually behave differently, or does
 * only the label differ? Groceries, shopping, packing, restaurants, places, simple and
 * checklist all fail that test — they are `collection` with different capability flags, an
 * icon and a name — and they are **templates** (ADR-032), which are data the server never
 * branches on. There is no `ListKind` here and there must never be one.
 */

/** The closed set. A fourth value is a product decision, not a pull request (ADR-031). */
export type ListBehaviour = 'collection' | 'watch' | 'meals';

/**
 * The exact destructive behaviour-change preview a client saw and must echo to confirm.
 *
 * `itemVersion` binds the human decision to the complete item generation, while the count
 * and ordered field labels bind it to the words rendered in the confirmation dialog.
 */
export interface ListBehaviourConfirmation {
  fromBehaviour: ListBehaviour;
  toBehaviour: ListBehaviour;
  itemVersion: number;
  /** Items actually carrying data that would be removed, not the List's total item count. */
  itemCount: number;
  fields: string[];
}

/**
 * What a `collection` can do, stored on the row and user-editable.
 *
 * Meaningful only on `collection`: `watch` uses `watchStatus` instead of a checkbox. On a
 * `watch` or `meals` list the flags are meaningless, not an error — the server stores what
 * the template gave it and the renderer ignores it, so a later behaviour change does not
 * lose the user's setting (`phase-03` §P3-01).
 */
export interface ListCapabilities {
  /** Items can be ticked off. `collection` only. */
  checkable: boolean;
  /** The item sheet offers a location field. `collection` only. */
  supportsLocation: boolean;
}

/**
 * The canonical list — the `META` row of its own partition, never the owner's
 * (`data-model.md` §3.3, ADR-042).
 *
 * `behaviour`, `capabilities`, `slot`, `icon` and `emptyStateCopy` are **copied** from the
 * selected template at creation and never re-resolved; `templateKey` is provenance only.
 * `rankVersion`, `itemVersion`, `rankRepairId` and `behaviourMigrationId` are storage-level
 * concurrency state that no client authors. `itemVersion` and the two work markers are never
 * serialised — the route tasks project them away.
 */
export interface List {
  listId: string;
  ownerId: UserId;
  behaviour: ListBehaviour;
  /** Immutable provenance + analytics only; never read to render. */
  templateKey: string;
  title: string;
  /** Frozen presentation copy from the selected template. */
  icon: string;
  /** Frozen presentation copy from the selected template. */
  emptyStateCopy: string;
  /** Frozen copy from the template, user-editable. */
  capabilities: ListCapabilities;
  /** Eligibility for a default destination. A *destination* marker, unrelated to behaviour. */
  slot: DefaultSlot | null;
  /** "This Packing list came from the New York Trip plan." */
  sourceActivityId?: string;
  itemCount: number;
  uncheckedCount: number;
  /** Owner + non-owner `MEMBER#` rows; `1` when private. */
  memberCount: number;
  /** Serialises server rank allocation; never client-authored. */
  rankVersion: number;
  /**
   * Serialises decisions made from the complete item set; never client-authored or serialised.
   *
   * Optional only while META rows written before P3-17 are lazily adopted. Readers treat an
   * absent value as zero and the first item mutation writes one.
   */
  itemVersion?: number;
  /** Blocks rank mutations and item-page reads until repair completes; never serialised. */
  rankRepairId?: string;
  /** Blocks item reads/mutations until behaviour migration commits; never serialised. */
  behaviourMigrationId?: string;
  archived: boolean;
  /** Backs `If-Match` on list-level edits. Moves only when the List row itself changes. */
  updatedAt: string;
  /**
   * The last write to any **item** in this list. Renders the Lists index's `Updated today`
   * line (`design-system.md` §7.2) and **backs nothing** (`data-model.md` §4.6).
   *
   * **Required, with no optional branch.** Nothing is deployed — there is no AWS account
   * before Phase 4 (`00-open-decisions.md` #50) — so there are no rows without it and no
   * absent value to read around. A developer's local table is covered by the same reset
   * boundary `ddb:create-table` already documents: it drops and recreates a table whose
   * schema has drifted. That is only true now; the same field after Phase 4 needs a
   * migration, which is the reason it is added here.
   *
   * It must never participate in `If-Match`. An ordinary item write would otherwise bump the
   * concurrency token every open list-settings sheet is holding — the same split ADR-039 made
   * between an Activity's `lastActivityAt` and `updatedAt`, for the same reason.
   */
  lastItemActivityAt: string;
}

/**
 * The near-pure pointer in a user's partition — one for the owner and one for each
 * **active** non-owner. `role` and `addedAt` and nothing else: no title, no counts, so a
 * rename is one write however many members exist (ADR-042).
 */
export interface ListIndex {
  listId: string;
  userId: UserId;
  role: 'owner' | 'member';
  addedAt: string;
}

/**
 * A non-owner member. The owner has no such row: ownership is `List.ownerId` plus the
 * owner's `ListIndex` pointer with `role: 'owner'` (`data-model.md` §4.6 "Shared lists").
 */
export interface ListMember {
  listId: string;
  personId: string;
  /** Absent while status is `invited`. */
  userId?: UserId;
  /** The member's Person for the owner; required for active non-owner members. */
  reciprocalPersonId?: string;
  displayName: string;
  email?: string;
  /** The owner has no `MEMBER#` row. */
  role: 'member';
  status: 'invited' | 'active';
  invitedBy: UserId;
  /** Immutable; copied into `ListIndex` and both `LLINK` keys. */
  addedAt: string;
  joinedAt?: string;
}

/**
 * Typed fields per behaviour, discriminated on `behaviour`. Present only for `watch` and
 * `meals`; a `collection` item never carries any of these (`plans-and-lists.md` §5.7).
 *
 * **`details.behaviour` always equals the owning `List.behaviour`**, the same rule
 * `Activity.details.kind` follows — but an item body does not carry the list's behaviour, so
 * the check is a helper the service applies with the loaded List
 * (`checkDetailsMatchBehaviour` in `../schemas/list.ts`).
 */
export type ListItemDetails =
  | {
      behaviour: 'watch';
      mediaKind?: 'movie' | 'show';
      watchStatus: 'want' | 'watching' | 'watched';
      season?: number;
      episode?: number;
    }
  | {
      behaviour: 'meals';
      ingredients?: {
        /** A client-minted `ing_` embedded-row identity, not an entity id (`data-model.md` §8). */
        ingredientId: string;
        name: string;
        quantity?: string;
        addedToListId?: string;
      }[];
    };

/**
 * One item. It carries **no Activity id**: the bridge to a Plan is a per-viewer
 * `ListItemActivityLink`, never a field here (ADR-034).
 */
export interface ListItem {
  itemId: string;
  listId: string;
  /** Lexo rank. Server-owned and mutable; sorted as `(rank, itemId)`. */
  rank: string;
  /** Storage-only mutation fence mirrored by the identity locator; never client-authored. */
  itemRevision: number;
  title: string;
  note?: string;
  /** Meaningful only for `collection` + `capabilities.checkable`. */
  checked: boolean;
  location?: { label: string; address?: string; lat?: number; lng?: number };
  /** "Chicken — Sunday dinner" */
  sourceActivityId?: string;
  /** Joined display of immutable canonical segments; extensions append but never recompute. */
  sourceLabel?: string;
  /**
   * Storage-only ownership of each rendered provenance segment.
   *
   * `sourceLabel` is the joined display value; decisions use this structure so a label that
   * itself contains ` · ` is never split and attributed to the wrong meal.
   */
  sourceProvenance?: { activityId: string; label: string }[];
  /** Present only for `watch` and `meals` behaviours. */
  details?: ListItemDetails;
}

/**
 * The viewer-local pointer from an item to the Plan this viewer made from it, keyed
 * viewer-first so one viewer has at most one current state line per item and another
 * member's private Plan is neither a conflict nor response data (ADR-034).
 */
export interface ListItemActivityLink {
  listId: string;
  itemId: string;
  viewerUserId: UserId;
  activityId: string;
  linkedAt: string;
}

/**
 * One catalogue record — a declarative preset, copied onto the `List` at creation and never
 * referenced afterwards (ADR-032). The records themselves live in `../lists/templates.ts`
 * (P3-02); this is only their shape.
 */
export interface ListTemplate {
  /** `'groceries'`, `'restaurants-to-try'`, `'bars-to-try'`, … */
  templateKey: string;
  /** Visible style name; `simple-list` uses `Blank`. */
  chooserLabel: string;
  /** One-line capability description in the chooser. */
  summary: string;
  /** Editable prefill after explicit template selection. */
  defaultTitle: string;
  icon: string;
  behaviour: ListBehaviour;
  /** Copied onto the List at creation. */
  capabilities: ListCapabilities;
  /** Seeds `List.slot`. */
  slot: DefaultSlot | null;
  emptyStateCopy: string;
}
