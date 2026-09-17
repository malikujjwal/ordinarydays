import { MAX_LIST_ITEMS, MAX_SOURCE_PROVENANCE_SEGMENTS } from '@od/shared';
import {
  canReceiveIngredients,
  formatIngredientTitle,
  provenanceLabel,
} from '@od/shared/lists';
import { type AddIngredientsToListInput, listItemSourceLabel } from '@od/shared/schemas';
import type { Activity, List, ListItem, MealIngredient } from '@od/shared/types';
import { AppError } from '../lib/errors.js';
import { IdempotencyRaceError, type IdempotencyReceipt } from '../lib/idempotency.js';
import {
  type IngredientAddition,
  ingredientMealUnchangedCheck,
} from '../repositories/activityRepository.js';
import { loadReceipt, receiptItem } from '../repositories/idempotencyRepository.js';
import {
  appendIngredientDestinationBinding,
  appendListItemCreates,
  appendSourceLabelExtension,
  getListMeta,
  type IngredientDestinationBinding,
  type ListAccessGrant,
  ListNotFoundError,
  ListRankRepairRequiredError,
  ListReadFenceError,
  ListSnapshotStaleError,
  newItemId,
  planListItemWrites,
  snapshotListItems,
} from '../repositories/listRepository.js';
import { TransactionBuilder, transactWrite } from '../repositories/tx.js';
import { ID_UNAVAILABLE } from './activityService.js';
import { assertActivityAccess, assertListAccess } from './authz.js';
import { withListWorkDrain } from './listMutationService.js';
import { repairListRanks } from './listRankRepairService.js';

/**
 * Meal ingredients → a destination list (`phase-03` §P3-17, `plans-and-lists.md` §7.3).
 *
 * ## What this service is, in one sentence
 *
 * It is the **only** way `sourceActivityId` and `sourceLabel` are ever written, and it does
 * nothing the user has not already confirmed.
 *
 * ## Suggest, never auto-create
 *
 * Creating a meal with four ingredients writes zero list items (acceptance criterion 13).
 * Nothing here runs on meal creation, on meal completion, or on a schedule; it runs when a
 * request arrives naming a list the user has already seen the name of. `agent-playbook.md`
 * §6.9's tell — "a `create` call inside a handler for a different operation" — is worth
 * checking against this file specifically, because it is the file most tempting to wire into
 * `activityService.create`.
 *
 * ## The destination is given, not resolved
 *
 * There is no `resolveSlot` call here. §P3-17 puts resolution on the **client**, over the
 * Lists projection it already holds, and P3-43 renders the answer before the button is
 * enabled — so by the time this runs the user has read the list's name. Resolving again
 * server-side would be a second implementation of the rule §P3-12 says must have exactly one,
 * and worse, it could disagree with the name the user was shown.
 *
 * ## One transaction, and why it had to become one
 *
 * Everything this action writes — created rows, structured/rendered label extensions,
 * permanent bindings for supplied ids absorbed by deduplication, the List META counters,
 * the meal's `addedToListId` markers and new version, and the idempotency receipt — commits
 * in a single `TransactWriteItems`.
 *
 * The first version did not. It ran three ordered steps and argued that making every step
 * before the receipt idempotent was equivalent. Review found two holes in that, and both were
 * real. A same-key retry after the receipt committed replayed the stored response and **never
 * ran the provenance write**, so the meal permanently disagreed with the list about what had
 * been added. And a conflict part-way through the creates left rows on the list from an
 * operation that then answered `503`. Neither is reachable now: there is one commit, so there
 * is nothing that can be half-done.
 *
 * The cost is a cap — `MAX_INGREDIENTS_PER_ADD`, thirty — because a transaction holds a
 * hundred items and each created row costs three. A meal may still hold sixty ingredients;
 * adding them all takes two taps. That is the cheaper side of the trade.
 *
 * ## Read, classify, build, commit — and retry the whole cycle
 *
 * Classification depends on what is on the list *now*: whether a matching row exists, and
 * whether its state is `done`. Between reading that and committing, the list may move. Every
 * condition in the transaction is therefore tied to something the read observed —
 * `rankVersion` for the list's shape, each extended row's `itemRevision`, each selected
 * ingredient's position, and the meal's `updatedAt` — and a condition failure re-runs the
 * **entire** cycle rather than retrying a stale plan. Reclassifying is the point: a row that
 * became `done` in the meantime must become a new item, not an extended label.
 */

const NOT_A_MEAL = 'Only a meal has ingredients to add.';
const NOT_A_COLLECTION = 'Ingredients can only be added to a simple list.';
const STALE_INGREDIENT =
  'Some of those ingredients have changed. Reopen the meal and try again.';
const BUSY = 'That list is busy. Try again.';
const LIST_FULL = 'List is full.';
const PROVENANCE_FULL = 'This item has too many source labels.';

/**
 * How many times the read/classify/commit cycle re-runs before giving up.
 *
 * Each attempt loses only to a change that landed **since its read**, and the contenders are
 * deliberate user acts — checking an item, renaming one, adding another. Three is generous
 * for that and bounded so a pathological writer cannot spin. `createListItems` uses the same
 * shape for the same reason.
 */
const ATTEMPTS = 3;

/** A selected ingredient, resolved against the meal's current array. */
interface ResolvedIngredient {
  readonly ingredientId: string;
  /** Where it sits **now**. Only ever used alongside its id, as a write condition. */
  readonly index: number;
  readonly ingredient: MealIngredient;
  readonly title: string;
  readonly itemId?: string;
}

/**
 * What the action did, per selected ingredient — the domain form of
 * `AddIngredientsToListResult`.
 *
 * It carries whole `ListItem`s, `itemRevision` and all, and the handler projects them through
 * `toListItem` on the way out. The wire shape drops that fence; a service returning the wire
 * shape directly would mean the trim happened here, in one of the several places it could be
 * forgotten, instead of in the one projection every list response already goes through.
 */
export interface AddedIngredients {
  readonly listId: string;
  readonly sourceLabel: string;
  readonly activityUpdatedAt: string;
  readonly ingredients: readonly {
    readonly ingredientId: string;
    readonly outcome: 'created' | 'labelled';
    readonly item: ListItem;
  }[];
}

/** Raised when a client-minted destination id was already taken; see {@link commit}. */
class TakenItemIdError extends Error {
  constructor() {
    super('That destination item id is already in use.');
    this.name = 'TakenItemIdError';
  }
}

/** Raised when a condition tied to the read failed, so the whole cycle must re-run. */
class ReclassifyError extends Error {
  constructor() {
    super('The list or the meal changed while this was being composed.');
    this.name = 'ReclassifyError';
  }
}

/**
 * `POST /v1/activities/:id/ingredients/add-to-list`.
 *
 * @param receiptFor built from the rows actually written, and committed **inside** the same
 * transaction as those rows. That is what makes a stored receipt and the provenance it
 * describes inseparable.
 */
export async function addIngredientsToList(
  userId: string,
  activityId: string,
  input: AddIngredientsToListInput,
  now: string,
  receiptFor?: (result: AddedIngredients) => IdempotencyReceipt,
  idempotencyKey?: string,
): Promise<AddedIngredients> {
  const access = await assertListAccess(userId, input.listId, 'write');

  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    try {
      return await attemptAdd(
        userId,
        activityId,
        input,
        access.index,
        now,
        receiptFor,
        idempotencyKey,
      );
    } catch (error) {
      if (!(error instanceof ReclassifyError)) throw error;
    }
  }
  /**
   * Three reads in a row each raced. Nothing has been written — every attempt was one
   * transaction — so the honest answer is the retryable conflict, not a partial success.
   */
  throw new AppError('internal', BUSY, undefined, 1);
}

/** One read/classify/build/commit pass. Either it commits whole or it wrote nothing. */
async function attemptAdd(
  userId: string,
  activityId: string,
  input: AddIngredientsToListInput,
  access: ListAccessGrant,
  now: string,
  receiptFor?: (result: AddedIngredients) => IdempotencyReceipt,
  idempotencyKey?: string,
): Promise<AddedIngredients> {
  /**
   * Re-read inside the cycle, not once outside it. The meal's ingredient array is half of
   * what the transaction conditions on, so a retry that reused the first read would keep
   * committing indexes resolved against an array that has since moved.
   */
  const { activity } = await assertActivityAccess(userId, activityId, 'owner');
  if (activity.type !== 'meal') refuse('activityId', NOT_A_MEAL);

  await mapped(() => loadCheckboxDestination(userId, input.listId, access, now));
  const selected = resolveSelected(activity, input);
  /**
   * The snapshot everything below is decided from — and the version it was taken under, which
   * the transaction must commit under too. See {@link snapshotListItems}.
   */
  const snapshot = await mapped(() =>
    withListWorkDrain(
      userId,
      input.listId,
      access,
      () =>
        snapshotListItems(
          userId,
          input.listId,
          access,
          selected.flatMap((row) => (row.itemId === undefined ? [] : [row.itemId])),
        ),
      now,
    ),
  );
  const existing = snapshot.items;
  assertDestinationsNotTombstoned(selected, snapshot.tombstonedDestinationIds);

  const sourceLabel = provenanceLabel(activity);
  assertRenderedSourceLabel(sourceLabel);

  const plan = classify(
    selected,
    existing,
    snapshot.ingredientDestinationBindings,
    input.listId,
    activityId,
    sourceLabel,
  );
  const basis = await planWrites(
    userId,
    input.listId,
    access,
    plan.creates.length,
    snapshot.rankVersion,
    snapshot.itemVersion,
    now,
  );
  assertCollection(basis.list);
  assertCapacity(basis.list, plan.creates.length);

  const created: ListItem[] = plan.creates.map((row, index) => ({
    itemId: row.itemId,
    listId: input.listId,
    rank: basis.ranks[index] as string,
    itemRevision: 0,
    title: row.title,
    state: 'open',
    sourceActivityId: activityId,
    sourceLabel,
    sourceProvenance: [
      { activityId, label: sourceLabel, ingredientIds: [...row.ingredientIds] },
    ],
  }));

  /**
   * `activity.updatedAt` — the version this whole plan was read and classified against —
   * never `now`. Since Option B (2026-09-16) this action does not write the meal, so it has
   * no new version to report; a caller that still held `activity.updatedAt` from its own read
   * is not stale.
   */
  const result = assemble(input.listId, sourceLabel, activity.updatedAt, plan, created);

  const builder = new TransactionBuilder(
    'addIngredientsToList',
    receiptFor === undefined ? 0 : 1,
  );
  const spans = appendListItemCreates(
    builder,
    input.listId,
    created,
    basis,
    now,
    new Map(
      plan.creates.flatMap((row) =>
        row.ingredientIdentity === undefined
          ? []
          : [[row.itemId, row.ingredientIdentity] as const],
      ),
    ),
  );
  for (const extension of plan.extensions) {
    appendSourceLabelExtension(
      builder,
      input.listId,
      extension.current,
      extension.next,
      now,
      extension.ingredientIdentity,
    );
  }
  for (const binding of plan.bindings) {
    appendIngredientDestinationBinding(
      builder,
      binding.ingredientIdentity,
      now,
      binding.current,
    );
  }

  builder.add(
    ingredientMealUnchangedCheck(
      activityId,
      selected.map(
        (resolved): IngredientAddition => ({
          index: resolved.index,
          ingredientId: resolved.ingredientId,
        }),
      ),
      activity.updatedAt,
    ),
  );

  const receiptIndex = builder.length;
  if (receiptFor !== undefined) builder.addReserved(receiptItem(receiptFor(result)));

  await commit(builder, {
    deletionGate: spans.deletionGate,
    createSpanEnd: spans.meta,
    receipt: receiptFor === undefined ? undefined : receiptIndex,
    createdCount: created.length,
    listId: input.listId,
    userId,
    access,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  });

  return result;
}

/**
 * Allocates ranks under both snapshot generations, repairing once if the gap is exhausted.
 *
 * The classification above decided what to create from rows read under both versions.
 * `rankVersion` catches structural writes and `itemVersion` catches field-only writes; moving
 * either is not a retry of this plan, but a reason to make a new one.
 */
async function planWrites(
  userId: string,
  listId: string,
  access: ListAccessGrant,
  count: number,
  expectedRankVersion: number,
  expectedItemVersion: number,
  now: string,
) {
  try {
    return await planListItemWrites(userId, listId, access, count, {
      expectedRankVersion,
      expectedItemVersion,
    });
  } catch (error) {
    if (error instanceof ListSnapshotStaleError) throw new ReclassifyError();
    if (error instanceof ListReadFenceError) {
      throw new AppError('internal', BUSY, undefined, 1);
    }
    if (!(error instanceof ListRankRepairRequiredError)) throw error;
    const repaired = await repairListRanks(userId, listId, access, now);
    if (!repaired) throw new AppError('internal', BUSY, undefined, 1);
    // The repair rewrote every rank, so the classification's rows are stale too.
    throw new ReclassifyError();
  }
}

interface CommitSpans {
  readonly deletionGate: number;
  /** Item, locator and tombstone conditions live in `(deletionGate, createSpanEnd)`. */
  readonly createSpanEnd: number;
  readonly receipt: number | undefined;
  readonly createdCount: number;
  readonly listId: string;
  readonly userId: string;
  readonly access: ListAccessGrant;
  readonly idempotencyKey?: string;
}

/**
 * Commits, and turns each condition failure into the answer that names what happened.
 *
 * DynamoDB reports which **item** failed, not which clause, so the index is the whole
 * diagnosis. Everything except the deletion gate, a genuinely full list and an idempotency
 * race is a {@link ReclassifyError}: the read is stale, and the caller must look again rather
 * than retry a plan built from what used to be true.
 */
async function commit(builder: TransactionBuilder, spans: CommitSpans): Promise<void> {
  try {
    await transactWrite(builder.build(), {
      operation: 'addIngredientsToList',
      onConditionFailed: (index) => {
        if (index === spans.deletionGate) return new ListNotFoundError();
        if (index === spans.receipt) return new IdempotencyRaceError();
        /**
         * A create-slot failure means the client's `itm_` is already taken, and re-reading
         * cannot free it — so this is the one failure that must not loop. Which answer it
         * deserves depends on **who** took it, and that is decided in the catch below rather
         * than here, because telling them apart needs a read.
         */
        if (index > spans.deletionGate && index < spans.createSpanEnd) {
          return new TakenItemIdError();
        }
        return new ReclassifyError();
      },
    });
  } catch (error) {
    /**
     * Who took the id.
     *
     * DynamoDB reports only the **first** failing item, and the item `Put` sits before the
     * receipt — so a concurrent duplicate of this very request surfaces here rather than as
     * an idempotency race, and answering `409` would tell a caller their write failed when
     * the winner had just performed it.
     *
     * A stored receipt under this key is what tells the two apart. Found: this is that race,
     * so hand it back as one and let the middleware answer from the winner's receipt.
     * Absent: something else holds the id — a replay after the receipt expired onto a row
     * the user has since marked done — which is a genuine conflict no retry would resolve.
     */
    if (error instanceof TakenItemIdError) {
      const winner =
        spans.idempotencyKey === undefined
          ? undefined
          : await loadReceipt(spans.userId, spans.idempotencyKey);
      throw winner === undefined
        ? new AppError('conflict', ID_UNAVAILABLE)
        : new IdempotencyRaceError();
    }
    /**
     * META carries two conditions that can each fail and reports neither. A strong reread
     * separates them: a full list is permanent and must say so, while a moved `rankVersion`
     * is the ordinary conflict the cycle re-runs. Same reasoning as `createListItems`.
     */
    if (error instanceof ReclassifyError && spans.createdCount > 0) {
      const current = await getListMeta(spans.userId, spans.listId, spans.access);
      if (
        current !== undefined &&
        current.itemCount + spans.createdCount > MAX_LIST_ITEMS
      ) {
        refuse('ingredients', LIST_FULL);
      }
    }
    throw error;
  }
}

/**
 * Resolves every selected `ing_` against the meal's **current** array, or rejects the lot.
 *
 * This is the function the stable id exists for. An action composed offline, queued, and
 * replayed after the user reordered their ingredients must still add the rows they picked —
 * so the id is looked up, and the index it happens to sit at now is only ever carried as a
 * fence condition (`ingredientMealUnchangedCheck`).
 *
 * **A missing id fails the whole request** (§P3-17), before anything is written and before
 * the transaction is even composed. The row was deleted or replaced, so the thing the user
 * selected no longer exists; adding the remaining ones would silently deliver a different
 * order than the one they confirmed, and resolving it to whatever now sits at that position
 * is precisely the position-is-identity bug the id removes.
 *
 * A repeated id is refused for the same reason rather than deduplicated: two selections of
 * one row is not something the picker can produce, so it is a client that has lost track of
 * which row is which, and guessing which of the two it meant is not this function's to do.
 */
function resolveSelected(
  activity: Activity,
  input: AddIngredientsToListInput,
): ResolvedIngredient[] {
  const ingredients =
    activity.details?.kind === 'meal' ? (activity.details.ingredients ?? []) : [];
  const byId = new Map(
    ingredients.map((ingredient, index) => [
      ingredient.ingredientId,
      { ingredient, index },
    ]),
  );

  const seen = new Set<string>();
  const seenItemIds = new Set<string>();
  return input.ingredients.map((selection, position) => {
    const path = `ingredients.${String(position)}.ingredientId`;
    if (seen.has(selection.ingredientId)) refuse(path, STALE_INGREDIENT);
    seen.add(selection.ingredientId);

    /**
     * Two ingredients sharing one destination `itm_` would make the transaction write the
     * same key twice, which DynamoDB refuses as a malformed request rather than a condition
     * failure. Caught here so it reads as the client mistake it is.
     */
    if (selection.itemId !== undefined && seenItemIds.has(selection.itemId)) {
      refuse(`ingredients.${String(position)}.itemId`, STALE_INGREDIENT);
    }
    if (selection.itemId !== undefined) seenItemIds.add(selection.itemId);

    const found = byId.get(selection.ingredientId);
    if (found === undefined) refuse(path, STALE_INGREDIENT);

    return {
      ingredientId: selection.ingredientId,
      index: found.index,
      ingredient: found.ingredient,
      title: formatIngredientTitle(found.ingredient.name, found.ingredient.quantity),
      ...(selection.itemId === undefined ? {} : { itemId: selection.itemId }),
    };
  });
}

interface PlannedCreate {
  readonly itemId: string;
  readonly title: string;
  /** Every selected ingredient this group merged into the one created row (Option B). */
  readonly ingredientIds: readonly string[];
  readonly ingredientIdentity?: IngredientDestinationBinding;
}

interface PlannedExtension {
  readonly current: ListItem;
  readonly next: ListItem;
  readonly ingredientIdentity?: IngredientDestinationBinding;
}

interface PlannedBinding {
  readonly ingredientIdentity: IngredientDestinationBinding;
  /** Present when the requested identity is the target's existing locator itself. */
  readonly current?: ListItem;
}

interface PlannedOutcome {
  readonly ingredientId: string;
  readonly outcome: 'created' | 'labelled';
  readonly itemId: string;
}

interface Plan {
  readonly creates: PlannedCreate[];
  readonly extensions: PlannedExtension[];
  readonly bindings: PlannedBinding[];
  /** Final forms of targets that already existed before this operation. */
  readonly existingTargets: ReadonlyMap<string, ListItem>;
  /** The request's order, so the response reads as the user's selection did. */
  readonly outcomes: readonly PlannedOutcome[];
}

/**
 * §7.3 step 6's duplicate rule, in its three states.
 *
 * Absent → create. Present and not `done` → extend that row's label and create nothing; it
 * is still on the shopping list, so a second line is noise. Present and `done` → create,
 * because a done row means it was already bought and the user needs it again.
 *
 * A fourth case falls out of replay: a target that already carries provenance owned by this
 * Activity needs no write at all. Ownership is read from `sourceProvenance`, never recovered
 * by splitting the rendered label; a valid label may itself contain ` · `.
 *
 * Classification is by normalized-title **group**. Every selection in a group resolves to
 * the same existing non-done row, or to the one row this operation creates. That is the
 * result the same selections would get if the first committed before the second classified.
 * Supplied ids occupy the same authoritative identity namespace whether they create or are
 * absorbed by grouping, so receipt expiry cannot turn them into new rows later. Replay is
 * the exact stored Activity/ingredient tuple, never merely a row carrying the same meal's
 * display provenance.
 */
function classify(
  selected: readonly ResolvedIngredient[],
  existing: readonly ListItem[],
  storedBindings: ReadonlyMap<string, IngredientDestinationBinding>,
  listId: string,
  activityId: string,
  sourceLabel: string,
): Plan {
  const byId = new Map(existing.map((item) => [item.itemId, item] as const));
  const uncheckedByTitle = new Map<string, ListItem>();
  for (const item of existing) {
    if (item.state === 'done') continue;
    const key = normalise(item.title);
    if (!uncheckedByTitle.has(key)) uncheckedByTitle.set(key, item);
  }

  const groups = new Map<string, ResolvedIngredient[]>();
  for (const row of selected) {
    const key = normalise(row.title);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [row]);
    else group.push(row);
  }

  const creates: PlannedCreate[] = [];
  const extensions: PlannedExtension[] = [];
  const bindings: PlannedBinding[] = [];
  const existingTargets = new Map<string, ListItem>();
  const outcomeByIngredient = new Map<string, PlannedOutcome>();

  for (const [titleKey, group] of groups) {
    const unresolved: ResolvedIngredient[] = [];
    let replayTarget: ListItem | undefined;
    let directTarget: ListItem | undefined;

    for (const resolved of group) {
      const requestedItemId = resolved.itemId;
      const binding =
        requestedItemId === undefined ? undefined : storedBindings.get(requestedItemId);
      if (binding !== undefined) {
        if (
          binding.listId !== listId ||
          binding.sourceActivityId !== activityId ||
          binding.ingredientId !== resolved.ingredientId
        ) {
          destinationUnavailable();
        }
        const target = byId.get(binding.itemId);
        if (target === undefined) destinationUnavailable();
        replayTarget ??= target;
        existingTargets.set(target.itemId, target);
        outcomeByIngredient.set(resolved.ingredientId, {
          ingredientId: resolved.ingredientId,
          outcome: binding.outcome,
          itemId: target.itemId,
        });
        continue;
      }

      const direct =
        requestedItemId === undefined ? undefined : byId.get(requestedItemId);
      if (
        direct !== undefined &&
        (direct.state === 'done' || normalise(direct.title) !== titleKey)
      ) {
        destinationUnavailable();
      }
      if (
        direct !== undefined &&
        directTarget !== undefined &&
        directTarget.itemId !== direct.itemId
      ) {
        destinationUnavailable();
      }
      directTarget ??= direct;
      unresolved.push(resolved);
    }

    if (unresolved.length === 0) continue;

    const eligibleReplayTarget =
      replayTarget !== undefined &&
      replayTarget.state !== 'done' &&
      normalise(replayTarget.title) === titleKey
        ? replayTarget
        : undefined;
    const match = directTarget ?? eligibleReplayTarget ?? uncheckedByTitle.get(titleKey);
    if (match !== undefined) {
      const next = extendProvenance(
        match,
        activityId,
        sourceLabel,
        unresolved.map((resolved) => resolved.ingredientId),
      );
      const requestedIdentities = unresolved.flatMap((resolved) =>
        resolved.itemId === undefined
          ? []
          : [
              {
                listId,
                requestedItemId: resolved.itemId,
                itemId: match.itemId,
                sourceActivityId: activityId,
                ingredientId: resolved.ingredientId,
                outcome: 'labelled' as const,
              },
            ],
      );
      const locatorIdentity = requestedIdentities.find(
        (binding) => binding.requestedItemId === match.itemId,
      );
      if (next !== match) {
        extensions.push({
          current: match,
          next,
          ...(locatorIdentity === undefined
            ? {}
            : { ingredientIdentity: locatorIdentity }),
        });
      } else if (locatorIdentity !== undefined) {
        bindings.push({ ingredientIdentity: locatorIdentity, current: match });
      }
      existingTargets.set(match.itemId, next);
      for (const resolved of unresolved) {
        outcomeByIngredient.set(resolved.ingredientId, {
          ingredientId: resolved.ingredientId,
          outcome: 'labelled',
          itemId: match.itemId,
        });
      }
      for (const binding of requestedIdentities) {
        if (binding.requestedItemId !== match.itemId) {
          bindings.push({ ingredientIdentity: binding });
        }
      }
      continue;
    }

    const primary = unresolved[0];
    if (primary === undefined) {
      throw new Error('A non-empty title group lost every unresolved selection.');
    }
    const createdItemId = primary.itemId ?? newItemId();
    const ingredientIdentity: IngredientDestinationBinding | undefined =
      primary.itemId === undefined
        ? undefined
        : {
            listId,
            requestedItemId: createdItemId,
            itemId: createdItemId,
            sourceActivityId: activityId,
            ingredientId: primary.ingredientId,
            outcome: 'created',
          };
    creates.push({
      itemId: createdItemId,
      title: primary.title,
      ingredientIds: unresolved.map((resolved) => resolved.ingredientId),
      ...(ingredientIdentity === undefined ? {} : { ingredientIdentity }),
    });
    for (const [index, resolved] of unresolved.entries()) {
      const outcome = index === 0 ? 'created' : 'labelled';
      outcomeByIngredient.set(resolved.ingredientId, {
        ingredientId: resolved.ingredientId,
        outcome,
        itemId: createdItemId,
      });
      if (resolved.itemId !== undefined && resolved.itemId !== createdItemId) {
        bindings.push({
          ingredientIdentity: {
            listId,
            requestedItemId: resolved.itemId,
            itemId: createdItemId,
            sourceActivityId: activityId,
            ingredientId: resolved.ingredientId,
            outcome,
          },
        });
      }
    }
  }

  return {
    creates,
    extensions,
    bindings,
    existingTargets,
    outcomes: selected.flatMap((row) => {
      const outcome = outcomeByIngredient.get(row.ingredientId);
      return outcome === undefined ? [] : [outcome];
    }),
  };
}

function normalise(title: string): string {
  return title.trim().toLowerCase();
}

/**
 * Every provenance segment on an item, `ingredientIds` normalised in.
 *
 * A row from before 2026-09-11 (P3-17) may carry only `sourceActivityId`/`sourceLabel` with
 * no `sourceProvenance`; a row from between then and Option B (2026-09-16) may carry
 * `sourceProvenance` segments with no `ingredientIds`. Both fall back to an **empty**
 * ingredient list rather than fail to parse — a segment written before ingredient identity
 * was recorded genuinely does not know which ingredient(s) produced it, and guessing would
 * misattribute `Added` to a row that never earned it under the new rule.
 */
function provenanceOf(
  item: ListItem,
): { activityId: string; label: string; ingredientIds: string[] }[] {
  if (item.sourceProvenance !== undefined && item.sourceProvenance.length > 0) {
    return item.sourceProvenance.map((segment) => ({
      activityId: segment.activityId,
      label: segment.label,
      ingredientIds: [...(segment.ingredientIds ?? [])],
    }));
  }
  if (item.sourceActivityId === undefined || item.sourceLabel === undefined) return [];
  // Legacy P3-17 rows had only these two fields. The entire rendered value belongs to the
  // recorded Activity; splitting it would corrupt a valid label containing ` · ` — a meal
  // title may contain it, and so may a stored pre-2026-09-11 `Sunday dinner · Chicken tacos`.
  return [
    { activityId: item.sourceActivityId, label: item.sourceLabel, ingredientIds: [] },
  ];
}

/**
 * Extends an existing target's provenance with a newly selected group of ingredients.
 *
 * ## The "no write" case, narrowed (Option B, 2026-09-16)
 *
 * Before this, a target that already carried a segment for this Activity was returned
 * unchanged outright — read as "this meal already told this row about itself, nothing to
 * repeat". That was right for the rendered `sourceLabel` (still is: one activity's label
 * appears once, however many of its ingredients land here) but wrong for **presence**: it
 * silently dropped every ingredient the segment did not already list. The first ingredient of
 * a meal to reach a row recorded itself; a later, different ingredient of the *same* meal
 * absorbed into the *same* row recorded nothing — and Option B's `origins`-derived `Added`
 * would call it never added. So the merge always runs; only the write is skipped, and only
 * once the merge proves there is genuinely nothing new to record.
 *
 * An existing segment's stored `label` is left as it was written, matching the prior
 * behaviour exactly (a rename between two add-ingredient calls on the same meal is outside
 * this change, as it always was).
 */
function extendProvenance(
  item: ListItem,
  activityId: string,
  label: string,
  ingredientIds: readonly string[],
): ListItem {
  const existing = provenanceOf(item);
  const segment = existing.find((candidate) => candidate.activityId === activityId);
  const mergedIds = new Set(segment?.ingredientIds ?? []);
  for (const ingredientId of ingredientIds) mergedIds.add(ingredientId);

  if (segment !== undefined && mergedIds.size === segment.ingredientIds.length) {
    return item;
  }
  if (segment === undefined && existing.length >= MAX_SOURCE_PROVENANCE_SEGMENTS) {
    refuse('ingredients', PROVENANCE_FULL);
  }

  const sourceProvenance =
    segment === undefined
      ? [...existing, { activityId, label, ingredientIds: [...mergedIds] }]
      : existing.map((candidate) =>
          candidate.activityId === activityId
            ? { ...candidate, ingredientIds: [...mergedIds] }
            : candidate,
        );
  const sourceLabel = sourceProvenance.map((entry) => entry.label).join(' · ');
  assertRenderedSourceLabel(sourceLabel);
  return {
    ...item,
    sourceActivityId: item.sourceActivityId ?? activityId,
    sourceLabel,
    sourceProvenance,
    itemRevision: item.itemRevision + 1,
  };
}

function assertRenderedSourceLabel(value: string): void {
  if (listItemSourceLabel.safeParse(value).success) return;
  refuse('ingredients', PROVENANCE_FULL);
}

function destinationUnavailable(): never {
  throw new AppError('conflict', ID_UNAVAILABLE);
}

/** The response, in the order the ingredients were sent, whatever happened to each. */
function assemble(
  listId: string,
  sourceLabel: string,
  activityUpdatedAt: string,
  plan: Plan,
  created: readonly ListItem[],
): AddedIngredients {
  const targets = new Map(plan.existingTargets);
  for (const item of created) targets.set(item.itemId, item);
  return {
    listId,
    sourceLabel,
    activityUpdatedAt,
    ingredients: plan.outcomes.map((row) => {
      const item = targets.get(row.itemId);
      if (item === undefined) {
        throw new Error('An ingredient outcome has no destination item.');
      }
      return { ingredientId: row.ingredientId, outcome: row.outcome, item };
    }),
  };
}

/**
 * The destination, and the one presentation rule that qualifies it.
 *
 * Checkbox presentation only. The integration creates ordinary `open` rows and treats `done`
 * matches as already bought. The destination is explicit; a `groceries` slot helps the caller
 * present it but never changes the List schema or enables a feature.
 */
async function loadCheckboxDestination(
  userId: string,
  listId: string,
  access: ListAccessGrant,
  now: string,
): Promise<List> {
  const list = await withListWorkDrain(
    userId,
    listId,
    access,
    async () => {
      const found = await getListMeta(userId, listId, access);
      if (found === undefined) throw new ListNotFoundError();
      return found;
    },
    now,
  );
  assertCollection(list);
  return list;
}

function assertCollection(list: List): void {
  // Shared with the destination picker so every client-offered list passes this last-line guard.
  if (!canReceiveIngredients(list)) refuse('listId', NOT_A_COLLECTION);
}

/**
 * Refuses a destination id a retained `ITEM_TOMBSTONE#` still owns.
 *
 * A deleted item keeps its id reserved for the replay window so that its **own** Undo can put
 * the row back, and §P3-10 and §P3-17 both say only that Undo may reclaim it. Created rows
 * have always obeyed this, through the per-row `ConditionCheck` in `appendListItemCreates`.
 *
 * An **absorbed** one had no such guard and needed one, because it writes to the same key
 * (raised in review). When a supplied destination id deduplicates into another row, the
 * binding is written at that id's `ITEMID#` locator to occupy it permanently — and its only
 * condition was that the locator be absent, which a delete makes true. So an ordinary add
 * could take a tombstoned id, and the delete's Undo then had nowhere to put the item back:
 * its own locator `Put` failed against the binding sitting there.
 *
 * Checked here, from the fenced snapshot, rather than as another `ConditionCheck`: a request
 * absorbing all thirty ingredients already builds ninety-four transaction items, and one more
 * check per binding would put it over the hundred-item ceiling. The snapshot reads the
 * tombstones under the same `itemVersion` the transaction commits under, so a delete landing
 * afterwards fails that fence and the retry re-reads and refuses here.
 *
 * `conflict` rather than `validation_failed`, matching what an ordinary create answers for a
 * taken id: the request was well-formed, and it is the world that says no.
 */
function assertDestinationsNotTombstoned(
  selected: readonly ResolvedIngredient[],
  tombstoned: ReadonlySet<string>,
): void {
  if (tombstoned.size === 0) return;
  for (const [position, resolved] of selected.entries()) {
    if (resolved.itemId === undefined || !tombstoned.has(resolved.itemId)) continue;
    throw new AppError('conflict', ID_UNAVAILABLE, [
      { path: `ingredients.${String(position)}.itemId`, message: ID_UNAVAILABLE },
    ]);
  }
}

/** Same precheck, same caveat: the transaction's own META condition is the enforcement. */
function assertCapacity(list: List, adding: number): void {
  if (list.itemCount + adding <= MAX_LIST_ITEMS) return;
  refuse('ingredients', LIST_FULL);
}

function refuse(path: string, message: string): never {
  throw new AppError('validation_failed', message, [{ path, message }]);
}

async function mapped<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof ListReadFenceError) {
      throw new AppError('internal', BUSY, undefined, 1);
    }
    throw error;
  }
}
