import { z } from 'zod';
import {
  MAX_ADDRESS_LEN,
  MAX_FREE_TEXT_LEN,
  MAX_INGREDIENTS,
  MAX_LIST_ITEMS,
  MAX_NOTES_LEN,
  MAX_TITLE_LEN,
} from '../constants.js';
import { cursor, ulidId, userId } from './common.js';
import { defaultSlot } from './user.js';

/**
 * Lists, items, the template shape and the create inputs
 * (`data-model.md` §4.6, `api-contract.md` §2.7, `plans-and-lists.md` §5).
 *
 * The interfaces are in `../types/list.ts`; `list.test.ts` pins the two together.
 *
 * ## The two rules this file exists to enforce
 *
 * **Behaviour is a closed enum of three and template keys are open strings.** The stored
 * List accepts any non-empty `templateKey`, because the catalogue is data and an old client
 * must not break when it grows; whether a key exists in the *current* catalogue is the
 * create service's question (P3-05), and it never substitutes another style. Nothing here
 * compares a template key to anything (ADR-031, ADR-032).
 *
 * **`details.behaviour` must equal the owning `List.behaviour`** — the same rule
 * `details.kind === type` follows for Activities. An item body does not carry its list's
 * behaviour, so the check is exported for the service to apply with the loaded List rather
 * than baked into a schema that cannot see it.
 */

const freeText = z.string().trim().max(MAX_FREE_TEXT_LEN);
const title = z
  .string()
  .trim()
  .min(1, 'A title is required')
  .max(MAX_TITLE_LEN, `A title is at most ${MAX_TITLE_LEN} characters`);

/**
 * Open, not an enum: the catalogue (P3-02) is data. Bounded so a key cannot smuggle a
 * paragraph through a field that only ever holds a short identifier.
 */
const templateKey = z
  .string()
  .trim()
  .min(1, 'A template is required')
  .max(MAX_FREE_TEXT_LEN);

/** Exactly three. Adding a fourth is a product decision — see `types/list.ts` and ADR-031. */
export const listBehaviour = z.enum(['collection', 'watch', 'meals']);

export const listCapabilities = z.object({
  checkable: z.boolean(),
  supportsLocation: z.boolean(),
});

/**
 * The stored List — the `META` row of its own partition (`data-model.md` §3.3).
 *
 * **Not strict, deliberately**, like `activity`: a row read back from DynamoDB carries
 * `pk`, `sk` and `entity` alongside these fields. `rankVersion`, `rankRepairId` and
 * `behaviourMigrationId` are storage-level state that the route tasks project away before a
 * response; they are here because this describes what storage holds.
 */
export const list = z
  .object({
    listId: ulidId('lst'),
    ownerId: userId,
    behaviour: listBehaviour,
    templateKey,
    title,
    icon: freeText,
    emptyStateCopy: freeText,
    capabilities: listCapabilities,
    slot: defaultSlot.nullable(),
    sourceActivityId: ulidId('act').optional(),
    itemCount: z.number().int().nonnegative(),
    uncheckedCount: z.number().int().nonnegative(),
    memberCount: z.number().int().positive(),
    rankVersion: z.number().int().nonnegative(),
    rankRepairId: z.string().min(1).optional(),
    behaviourMigrationId: z.string().min(1).optional(),
    archived: z.boolean(),
    updatedAt: z.string().min(1),
  })
  .meta({ id: 'List' });

/** The near-pure pointer: `role` and `addedAt` and nothing else (ADR-042). */
export const listIndex = z.object({
  listId: ulidId('lst'),
  userId,
  role: z.enum(['owner', 'member']),
  addedAt: z.string().min(1),
});

/** A non-owner member row. The owner has none. */
export const listMember = z.object({
  listId: ulidId('lst'),
  personId: ulidId('psn'),
  userId: userId.optional(),
  reciprocalPersonId: ulidId('psn').optional(),
  displayName: freeText.min(1),
  email: z.email().optional(),
  role: z.literal('member'),
  status: z.enum(['invited', 'active']),
  invitedBy: userId,
  addedAt: z.string().min(1),
  joinedAt: z.string().min(1).optional(),
});

/**
 * Typed fields per behaviour, discriminated on `behaviour` (`data-model.md` §4.6).
 *
 * Arms for `watch` and `meals` only: a `collection` item has no `details`, so any `details`
 * on one is a mismatch by construction. **Every arm is strict**, stored and input alike: a
 * nested object carries no `pk`/`sk`, so there is nothing legitimate to strip, and a watch
 * body carrying `ingredients` — or a meals body carrying `watchStatus` — must fail rather
 * than be silently emptied of the fields it was actually trying to send.
 */
const watchDetails = z.strictObject({
  behaviour: z.literal('watch'),
  mediaKind: z.enum(['movie', 'show']).optional(),
  watchStatus: z.enum(['want', 'watching', 'watched']),
  season: z.number().int().min(0).max(1000).optional(),
  episode: z.number().int().min(0).max(10000).optional(),
});

/** What a client may say about an ingredient. `addedToListId` is deliberately not here. */
const ingredientInputShape = {
  ingredientId: ulidId('ing'),
  name: freeText.min(1),
  quantity: freeText.optional(),
} as const;

function mealsDetails<T extends z.ZodRawShape>(ingredient: T) {
  return z.strictObject({
    behaviour: z.literal('meals'),
    ingredients: z.array(z.strictObject(ingredient)).max(MAX_INGREDIENTS).optional(),
  });
}

export const listItemDetails = z.discriminatedUnion('behaviour', [
  watchDetails,
  mealsDetails({
    ...ingredientInputShape,
    /** Server-owned "Added" state, written only by the add-to-list action (P3-17). */
    addedToListId: ulidId('lst').optional(),
  }),
]);

/**
 * The `details` a create may carry. Identical to the stored union except that the meals
 * arm's ingredients **omit and reject `addedToListId`**: it records that the authorised
 * `POST /v1/activities/:id/ingredients/add-to-list` action ran, and a client that could set
 * it on an ordinary create would be fabricating that for any well-formed `lst_` id.
 */
export const listItemDetailsInput = z.discriminatedUnion('behaviour', [
  watchDetails,
  mealsDetails(ingredientInputShape),
]);

/** A place on a `collection` item. No `mapUrl`, unlike `activityLocation` — §4.6 has none. */
export const listItemLocation = z.object({
  label: freeText,
  address: z.string().trim().max(MAX_ADDRESS_LEN).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
});

/** The stored item. Non-strict for the same reason as `list`. */
export const listItem = z
  .object({
    itemId: ulidId('itm'),
    listId: ulidId('lst'),
    rank: z.string().min(1),
    itemRevision: z.number().int().nonnegative(),
    title,
    note: z.string().max(MAX_NOTES_LEN).optional(),
    checked: z.boolean(),
    location: listItemLocation.optional(),
    sourceActivityId: ulidId('act').optional(),
    sourceLabel: freeText.optional(),
    details: listItemDetails.optional(),
  })
  .meta({ id: 'ListItem' });

/** The viewer-local pointer from an item to this viewer's Plan (ADR-034). */
export const listItemActivityLink = z.object({
  listId: ulidId('lst'),
  itemId: ulidId('itm'),
  viewerUserId: userId,
  activityId: ulidId('act'),
  linkedAt: z.string().min(1),
});

/** One catalogue record (ADR-032). The records are P3-02's; this is their shape. */
export const listTemplate = z
  .object({
    templateKey,
    chooserLabel: freeText.min(1),
    summary: freeText.min(1),
    defaultTitle: title,
    icon: freeText.min(1),
    behaviour: listBehaviour,
    capabilities: listCapabilities,
    slot: defaultSlot.nullable(),
    emptyStateCopy: freeText.min(1),
  })
  .meta({ id: 'ListTemplate' });

/**
 * `details.behaviour` must equal the list's `behaviour`. Exported, unlike the Activity
 * twin, because an item body does not carry its list's behaviour: the service loads the
 * List and applies this with it, at every public read and write boundary. Absent `details`
 * is accepted here — whether a behaviour *requires* them is the write path's rule (P3-08).
 */
export function checkDetailsMatchBehaviour(
  value: { behaviour: string; details?: { behaviour: string } | undefined },
  ctx: z.RefinementCtx,
  /** Where `details` sits in the body being refined — `['items', 3]` for a bulk member. */
  pathPrefix: readonly (string | number)[] = [],
): void {
  if (value.details !== undefined && value.details.behaviour !== value.behaviour) {
    ctx.addIssue({
      code: 'custom',
      message: `details.behaviour must be "${value.behaviour}" to match the list`,
      path: [...pathPrefix, 'details', 'behaviour'],
    });
  }
}

/**
 * `POST /v1/lists` (`api-contract.md` §2.7).
 *
 * **Strict.** `behaviour`, `capabilities`, `slot`, `icon` and `emptyStateCopy` are not
 * fields a client may send — they are copied from the selected template — so a body carrying
 * one is a `400` naming it, not a save that quietly ignores it. No owner, timestamp or
 * counter either: authority fields are server-set (`data-model.md` §8).
 *
 * `listId` is the client's own `lst_` ULID, minted before the request leaves the device
 * (ADR-055). Identity only, and optional so omitting it keeps server minting byte-identical.
 */
export const createListInput = z
  .strictObject({
    listId: ulidId('lst').optional(),
    title,
    /** The template/style the user explicitly selected. Never matched from the title. */
    templateKey,
    /** Must name an owned Plan; forces the copied `slot` to `null`. */
    sourceActivityId: ulidId('act').optional(),
  })
  .meta({ id: 'CreateListInput' });

export type CreateListInput = z.infer<typeof createListInput>;

/**
 * `PATCH /v1/lists/:id` (`api-contract.md` §2.7, P3-09).
 *
 * **Strict**, and that strictness is the change-rules table on the wire. `behaviour` is not
 * a field this route accepts — it goes through the replay-protected
 * `POST /v1/lists/:id/behaviour`, because a behaviour change is a gated, resumable item
 * migration rather than one conditional `META` write — and `templateKey` is immutable
 * provenance. A body carrying either is a `400` naming it, exactly as `createListInput`
 * refuses the fields the catalogue owns, never a save that quietly ignores half of what was
 * sent.
 *
 * `slot` is **nullable**: absent leaves the current slot alone and `null` clears it, which
 * are different intentions and must stay distinguishable — the same distinction
 * `defaultReminderOffset` makes on the profile. Clearing or changing a slot also removes the
 * caller's matching profile default, in the same transaction (P3-12).
 *
 * `capabilities` is a **partial** patch of the two flags rather than the whole object, so
 * one switch in List settings can be flipped without the request restating the other. The
 * service merges it onto the stored pair and records the whole prior pair as the Undo
 * inverse.
 */
export const listCapabilitiesPatch = z
  .strictObject({
    checkable: z.boolean().optional(),
    supportsLocation: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Name at least one capability to change',
  });

export const patchListInput = z
  .strictObject({
    title: title.optional(),
    capabilities: listCapabilitiesPatch.optional(),
    slot: defaultSlot.nullable().optional(),
    archived: z.boolean().optional(),
  })
  .meta({ id: 'PatchListInput' });

export type PatchListInput = z.infer<typeof patchListInput>;

/**
 * `POST /v1/lists/:id/behaviour` (`api-contract.md` §2.7, P3-09).
 *
 * One target behaviour and nothing else. Strict, so a body that also tried to carry
 * `capabilities` or a `confirmDataLoss` flag is a `400` naming it: the confirmation is a
 * **query parameter** on a deliberately separate, newly keyed logical action, not a field a
 * client can set in the same body it would have sent unconfirmed.
 */
export const changeListBehaviourInput = z
  .strictObject({ behaviour: listBehaviour })
  .meta({ id: 'ChangeListBehaviourInput' });

export type ChangeListBehaviourInput = z.infer<typeof changeListBehaviourInput>;

/** `POST /v1/lists/:id/behaviour` query. Strict, so a misspelled flag is a named `400`. */
export const changeListBehaviourQuery = z
  .strictObject({ confirmDataLoss: z.enum(['true', 'false']).optional() })
  .meta({ id: 'ChangeListBehaviourQuery' });

/**
 * Where the `409 conflict` preview for an unconfirmed destructive behaviour change puts its
 * two structured facts.
 *
 * The envelope's `details[]` is its only structured slot, so the preview travels there as
 * `{ path, message }` pairs — the same encoding `PATCH /v1/activities/:id` uses to return
 * the current `updatedAt` alongside a stale-edit `409` (P1-13). The paths are **exported
 * rather than described**, so the client that maps them back into a typed shape (P3-24) and
 * the service that emits them cannot drift:
 *
 * ```
 * { path: 'confirmDataLoss.itemCount', message: '7' }
 * { path: 'confirmDataLoss.fields.0',  message: 'Watch status' }
 * { path: 'confirmDataLoss.fields.1',  message: 'Season' }
 * ```
 *
 * `itemCount` is the number of items **actually carrying** the data being removed, never the
 * list's size (`interaction-contract.md` §1a.1 rule 2), and each `fields.<n>` entry is one
 * user-facing label in the order the confirmation should read them (rule 4). The client
 * composes the dialog sentence; the server never sends a pre-joined one, because the copy
 * around the list's own title belongs to the surface that knows it.
 */
export const DATA_LOSS_DETAIL_PATHS = {
  itemCount: 'confirmDataLoss.itemCount',
  field: (index: number) => `confirmDataLoss.fields.${String(index)}`,
} as const;

/**
 * One item of `POST /v1/lists/:id/items`, and one member of `bulk`.
 *
 * Strict, so `checked`, `rank`, `itemRevision`, `sourceActivityId` and `sourceLabel` — all
 * server-derived — are rejected rather than dropped. `itemId` is the client-minted `itm_`
 * ULID, optional for the same reason as `listId` above.
 */
const createListItemFields = {
  itemId: ulidId('itm').optional(),
  title,
  note: z.string().max(MAX_NOTES_LEN).optional(),
  location: listItemLocation.optional(),
  details: listItemDetailsInput.optional(),
  /** Drives the lexo rank. Absent means the end of the list. */
  afterItemId: ulidId('itm').optional(),
} as const;

export const createListItemInput = z
  .strictObject(createListItemFields)
  .meta({ id: 'CreateListItemInput' });

export type CreateListItemInput = z.infer<typeof createListItemInput>;

/** `POST /v1/lists/:id/items/bulk`. Ordinary item creation only; every member its own id. */
export const bulkCreateListItemsInput = z
  .strictObject({
    items: z.array(z.strictObject(createListItemFields)).min(1).max(MAX_LIST_ITEMS),
  })
  .meta({ id: 'BulkCreateListItemsInput' });

export type BulkCreateListItemsInput = z.infer<typeof bulkCreateListItemsInput>;

/**
 * The item inputs, bound to a loaded List's behaviour.
 *
 * What the service actually validates a body against: the strict shape above plus
 * `checkDetailsMatchBehaviour`. Building the refined schema here rather than in a handler
 * keeps the rule in one place and the issue path (`details.behaviour`) identical on both
 * routes.
 */
export function createListItemInputFor(behaviour: z.infer<typeof listBehaviour>) {
  return createListItemInput.superRefine((value, ctx) => {
    checkDetailsMatchBehaviour({ behaviour, details: value.details }, ctx);
  });
}

export function bulkCreateListItemsInputFor(behaviour: z.infer<typeof listBehaviour>) {
  return bulkCreateListItemsInput.superRefine((value, ctx) => {
    value.items.forEach((item, index) => {
      checkDetailsMatchBehaviour({ behaviour, details: item.details }, ctx, [
        'items',
        index,
      ]);
    });
  });
}

/**
 * The List an API response carries (`api-contract.md` §2.7, P3-05).
 *
 * The stored shape minus the two storage-only work markers: `rankRepairId` and
 * `behaviourMigrationId` gate reads while repair or migration runs and are **never
 * serialised** (`data-model.md` §4.6). `rankVersion` stays — item-page cursors are bound to
 * it, and the client hands it back opaquely inside them.
 */
export const listView = list
  .omit({ rankRepairId: true, behaviourMigrationId: true })
  .meta({ id: 'ListView' });

/** The ListItem a response carries: the stored shape minus its storage-only revision fence. */
export const listItemView = listItem
  .omit({ itemRevision: true })
  .meta({ id: 'ListItemView' });

/**
 * One row of a list detail's item page: the item plus the **caller's own** Activity link,
 * present only when this viewer has planned the item and may still read that Activity.
 * Another member's pointer is never response data (ADR-034, `api-contract.md` §3).
 */
export const listDetailItem = z
  .object({
    item: listItemView,
    viewerLink: listItemActivityLink.optional(),
  })
  .meta({ id: 'ListDetailItem' });

/**
 * `GET /v1/lists/:id` (`api-contract.md` §2.7): META always; the fenced first item page and
 * its rank-version-bound cursor only when `includeItems=true` asked for them. Later item
 * pages go through `GET /v1/lists/:id/items?cursor=` (P3-08).
 */
export const listDetail = z
  .object({
    list: listView,
    items: z.array(listDetailItem).optional(),
    nextCursor: cursor.optional(),
  })
  .meta({ id: 'ListDetail' });

/** `DELETE /v1/lists/:id` names what was removed, per §1's DELETE-answers-200 rule. */
export const deletedList = z
  .object({ listId: ulidId('lst') })
  .meta({ id: 'DeletedList' });

/** `GET /v1/lists` query. Strict, so a misspelled parameter is a `400` naming it. */
export const listListQuery = z
  .strictObject({ cursor: cursor.optional() })
  .meta({ id: 'ListListQuery' });

/** `GET /v1/lists/:id` query. `includeItems=true` asks for the fenced first item page. */
export const listDetailQuery = z
  .strictObject({ includeItems: z.enum(['true', 'false']).optional() })
  .meta({ id: 'ListDetailQuery' });

/** `GET /v1/lists/:id/items` query. Strict, so a misspelled parameter is a named `400`. */
export const listItemPageQuery = z
  .strictObject({ cursor: cursor.optional() })
  .meta({ id: 'ListItemPageQuery' });

/**
 * `PATCH /v1/lists/:id/items/:itemId` (`api-contract.md` §2.7, P3-08).
 *
 * **Strict**, so `rank`, `itemRevision`, `listId` and the provenance fields — all
 * server-owned — are a `400` naming them rather than a save that quietly ignores them.
 * There is no client `If-Match`: item writes are per-field last-write-wins, and optimistic
 * concurrency on every checkbox in a grocery list would produce constant spurious `409`s
 * for no benefit (`data-model.md` §4.6 "Concurrency").
 *
 * `note`, `location` and `details` accept `null` to **clear** the field, the same way
 * `defaultReminderOffset` does on the profile: absent means "leave it alone" and `null`
 * means "remove it", which are different intentions and must stay distinguishable.
 *
 * `afterItemId` requests a reorder — `null` moves the item to the front, an id moves it
 * after that item. Absent means no reorder at all, which is why it is nullable rather than
 * merely optional.
 */
export const patchListItemInput = z
  .strictObject({
    title: title.optional(),
    checked: z.boolean().optional(),
    note: z.string().max(MAX_NOTES_LEN).nullable().optional(),
    location: listItemLocation.nullable().optional(),
    details: listItemDetailsInput.nullable().optional(),
    afterItemId: ulidId('itm').nullable().optional(),
  })
  .meta({ id: 'PatchListItemInput' });

export type PatchListItemInput = z.infer<typeof patchListItemInput>;

/** The patch input bound to a loaded List's behaviour, like the create helpers above. */
export function patchListItemInputFor(behaviour: z.infer<typeof listBehaviour>) {
  return patchListItemInput.superRefine((value, ctx) => {
    checkDetailsMatchBehaviour(
      { behaviour, ...(value.details == null ? {} : { details: value.details }) },
      ctx,
    );
  });
}

/**
 * `POST /v1/lists/:id/undo` (`api-contract.md` §2.7, P3-10).
 *
 * The opaque token and nothing else. Strict, and deliberately so: a client must never send
 * the deleted rows back as authority, and a body that tried to would be a `400` naming the
 * field rather than a restore from data the server did not record.
 */
export const undoListOperationInput = z
  .strictObject({ undoToken: z.string().min(1) })
  .meta({ id: 'UndoListOperationInput' });

export type UndoListOperationInput = z.infer<typeof undoListOperationInput>;

/**
 * What `POST /v1/lists/:id/undo` answers with — a **discriminated union**, not a count with
 * exceptions (P3-10; `api-contract.md` §2.7 amended in the same pull request).
 *
 * §2.7 said two things that did not fit together: the route "returns `{ affectedCount }`",
 * and a mismatched, consumed or retention-expired token "returns the typed
 * expired/no-longer-applicable result and writes nothing". A count cannot express the second,
 * and a new `ErrorCode` would be wrong for both — none of these is a failed request. The
 * server was asked to apply a compensation, and it answers with what happened to it:
 *
 * - `applied` — the inverse ran; `affectedCount` is what it touched.
 * - `expired` — the token is past `MAX_AUTOMATIC_INTENT_AGE_DAYS`, or names no operation, or
 *   its hash does not match. The three are **deliberately indistinguishable**: telling a
 *   caller that a token is well-formed but expired, rather than simply unknown, tells them
 *   something about an operation they may not own.
 * - `no_longer_applicable` — the operation is retained and the token is right, but the world
 *   has moved: it was already used, or a settings inverse's recorded preconditions no longer
 *   hold because someone edited what it would restore.
 *
 * All three are `200`, because all three are true answers to the question asked. Nothing is
 * written for the last two.
 */
export const listUndoResult = z
  .discriminatedUnion('outcome', [
    z.strictObject({
      outcome: z.literal('applied'),
      affectedCount: z.number().int().nonnegative(),
    }),
    z.strictObject({ outcome: z.literal('expired') }),
    z.strictObject({ outcome: z.literal('no_longer_applicable') }),
  ])
  .meta({ id: 'ListUndoResult' });

/**
 * What a reversible item mutation answers with (`api-contract.md` §2.7).
 *
 * `undoExpiresAt` is the **UI offer deadline**, not the server's replay deadline: the client
 * must stop offering Undo at that instant, while an inverse the user already accepted stays
 * valid until the shared retention window expires. Conflating the two is what would make an
 * accepted offline Undo expire in transit.
 */
export const reversibleItemMutation = z
  .object({
    affectedCount: z.number().int().nonnegative(),
    undoToken: z.string().min(1),
    undoExpiresAt: z.string().min(1),
  })
  .meta({ id: 'ReversibleItemMutation' });

/**
 * What a list-settings mutation answers with — `PATCH /v1/lists/:id` and
 * `POST /v1/lists/:id/behaviour` (`api-contract.md` §2.7).
 *
 * **A union of two shapes, not one shape with two optional fields.** An Undo offer is a token
 * *and* the deadline it is offered until; a payload carrying one without the other is an
 * offer no client can act on, and modelling them as independent optionals is what would let a
 * server emit half of one and a client believe it. Both arms are strict, so a half payload
 * matches neither and fails.
 *
 * The offer's absence is meaningful rather than incidental: a rename records no inverse
 * (`interaction-contract.md` §4.1 has no undo row for it), a patch that changes nothing has
 * nothing to take back, and a behaviour change that **lost** data was confirmed rather than
 * offered — repeating the call with `?confirmDataLoss=true` is its only path, so a token there
 * would promise a restore the server cannot make.
 *
 * `undoExpiresAt` is the UI offer deadline on the same terms as {@link reversibleItemMutation}:
 * stop offering at that instant, while an inverse the user already accepted stays valid
 * until the shared retention window expires.
 */
export const listSettingsMutation = z
  .union([
    z.strictObject({
      list: listView,
      undoToken: z.string().min(1),
      undoExpiresAt: z.string().min(1),
    }),
    z.strictObject({ list: listView }),
  ])
  .meta({ id: 'ListSettingsMutation' });
