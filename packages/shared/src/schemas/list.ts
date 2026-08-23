import { z } from 'zod';
import {
  MAX_ADDRESS_LEN,
  MAX_FREE_TEXT_LEN,
  MAX_INGREDIENTS,
  MAX_LIST_ITEMS,
  MAX_NOTES_LEN,
  MAX_TITLE_LEN,
} from '../constants.js';
import { ulidId, userId } from './common.js';
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
 * on one is a mismatch by construction. Each arm names only its own fields, so a body
 * carrying `season` on a meal fails rather than being silently dropped.
 */
export const listItemDetails = z.discriminatedUnion('behaviour', [
  z.object({
    behaviour: z.literal('watch'),
    mediaKind: z.enum(['movie', 'show']).optional(),
    watchStatus: z.enum(['want', 'watching', 'watched']),
    season: z.number().int().min(0).max(1000).optional(),
    episode: z.number().int().min(0).max(10000).optional(),
  }),
  z.object({
    behaviour: z.literal('meals'),
    ingredients: z
      .array(
        z.object({
          ingredientId: ulidId('ing'),
          name: freeText.min(1),
          quantity: freeText.optional(),
          addedToListId: ulidId('lst').optional(),
        }),
      )
      .max(MAX_INGREDIENTS)
      .optional(),
  }),
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
  details: listItemDetails.optional(),
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
