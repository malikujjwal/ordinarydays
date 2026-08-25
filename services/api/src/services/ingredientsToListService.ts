import { MAX_LIST_ITEMS } from '@od/shared';
import { formatIngredientTitle, provenanceLabel } from '@od/shared/lists';
import type { AddIngredientsToListInput } from '@od/shared/schemas';
import { type Instant, type TimeZone, toWallDate } from '@od/shared/time';
import type { Activity, List, ListItem, MealIngredient } from '@od/shared/types';
import { AppError } from '../lib/errors.js';
import { IdempotencyRaceError, type IdempotencyReceipt } from '../lib/idempotency.js';
import {
  type IngredientAddition,
  ingredientsAddedToListItem,
} from '../repositories/activityRepository.js';
import { loadReceipt, receiptItem } from '../repositories/idempotencyRepository.js';
import {
  appendListItemCreates,
  appendSourceLabelExtension,
  getListMeta,
  type ListAccessGrant,
  ListNotFoundError,
  ListRankRepairRequiredError,
  ListReadFenceError,
  ListSnapshotStaleError,
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
 * Lists projection it already holds, and P3-42 renders the answer before the button is
 * enabled — so by the time this runs the user has read the list's name. Resolving again
 * server-side would be a second implementation of the rule §P3-12 says must have exactly one,
 * and worse, it could disagree with the name the user was shown.
 *
 * ## One transaction, and why it had to become one
 *
 * Everything this action writes — created rows, extended labels, the List META counters, the
 * meal's `addedToListId` markers and its new version, and the idempotency receipt — commits
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
 * whether it is checked. Between reading that and committing, the list may move. Every
 * condition in the transaction is therefore tied to something the read observed —
 * `rankVersion` for the list's shape, each extended row's `itemRevision`, each selected
 * ingredient's position, and the meal's `updatedAt` — and a condition failure re-runs the
 * **entire** cycle rather than retrying a stale plan. Reclassifying is the point: a row that
 * was checked in the meantime must become a new item, not an extended label.
 */

const NOT_A_MEAL = 'Only a meal has ingredients to add.';
const NOT_A_COLLECTION = 'Ingredients can only be added to a simple list.';
const STALE_INGREDIENT =
  'Some of those ingredients have changed. Reopen the meal and try again.';
const BUSY = 'That list is busy. Try again.';
const LIST_FULL = 'List is full.';

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
  readonly itemId: string;
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

  const list = await mapped(() => loadCollection(userId, input.listId, access, now));
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
      () => snapshotListItems(userId, input.listId, access),
      now,
    ),
  );
  const existing = snapshot.items;

  const sourceLabel = provenanceLabel(
    labelSource(activity),
    labelsFromOtherMeals(existing, activityId),
    today(activity, now),
  );

  const plan = classify(selected, existing, sourceLabel);
  assertCapacity(list, plan.creates.length);

  const basis = await planWrites(
    userId,
    input.listId,
    access,
    plan.creates.length,
    snapshot.rankVersion,
    now,
  );

  const created: ListItem[] = plan.creates.map((resolved, index) => ({
    itemId: resolved.itemId,
    listId: input.listId,
    rank: basis.ranks[index] as string,
    itemRevision: 0,
    title: resolved.title,
    checked: false,
    sourceActivityId: activityId,
    sourceLabel,
  }));

  const labelled: ListItem[] = plan.extended.map((row) => ({
    ...row.match,
    sourceLabel:
      row.match.sourceLabel === undefined || row.match.sourceLabel === ''
        ? sourceLabel
        : `${row.match.sourceLabel} · ${sourceLabel}`,
    itemRevision: row.match.itemRevision + 1,
  }));

  const result = assemble(input.listId, sourceLabel, now, plan, labelled, created);

  const builder = new TransactionBuilder(
    'addIngredientsToList',
    receiptFor === undefined ? 0 : 1,
  );
  const spans = appendListItemCreates(builder, input.listId, created, basis, now);
  for (const [index, row] of plan.extended.entries()) {
    appendSourceLabelExtension(
      builder,
      input.listId,
      row.match,
      labelled[index]?.sourceLabel ?? sourceLabel,
      now,
    );
  }

  builder.add(
    ingredientsAddedToListItem(
      activityId,
      input.listId,
      selected.map(
        (resolved): IngredientAddition => ({
          index: resolved.index,
          ingredientId: resolved.ingredientId,
        }),
      ),
      activity.updatedAt,
      now,
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
 * Allocates ranks under the snapshot's own version, repairing once if the gap is exhausted.
 *
 * `expectedRankVersion` is the whole point: the classification above decided what to create
 * from rows read at that version, so committing under a **later** one would accept a create
 * that landed in between and write the duplicate the classification was meant to prevent.
 * A moved version is not a retry of this plan — it is a reason to make a new one.
 */
async function planWrites(
  userId: string,
  listId: string,
  access: ListAccessGrant,
  count: number,
  expectedRankVersion: number,
  now: string,
) {
  try {
    return await planListItemWrites(userId, listId, access, count, {
      expectedRankVersion,
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
     * the user has since checked — which is a genuine conflict no retry would resolve.
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

/** The three fields §7.5's rules read, and nothing else the Activity happens to carry. */
function labelSource(activity: Activity) {
  const slot = activity.details?.kind === 'meal' ? activity.details.mealSlot : undefined;
  return {
    title: activity.title,
    ...(activity.schedule === undefined ? {} : { date: activity.schedule.date }),
    ...(slot === undefined ? {} : { mealSlot: slot }),
  };
}

/**
 * Resolves every selected `ing_` against the meal's **current** array, or rejects the lot.
 *
 * This is the function the stable id exists for. An action composed offline, queued, and
 * replayed after the user reordered their ingredients must still add the rows they picked —
 * so the id is looked up, and the index it happens to sit at now is only ever carried as a
 * write condition (`ingredientsAddedToListItem`).
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
    if (seenItemIds.has(selection.itemId)) {
      refuse(`ingredients.${String(position)}.itemId`, STALE_INGREDIENT);
    }
    seenItemIds.add(selection.itemId);

    const found = byId.get(selection.ingredientId);
    if (found === undefined) refuse(path, STALE_INGREDIENT);

    return {
      ingredientId: selection.ingredientId,
      index: found.index,
      ingredient: found.ingredient,
      title: formatIngredientTitle(found.ingredient.name, found.ingredient.quantity),
      itemId: selection.itemId,
    };
  });
}

interface Plan {
  readonly creates: ResolvedIngredient[];
  readonly extended: { resolved: ResolvedIngredient; match: ListItem }[];
  /** Selections whose row already carries this label: nothing to write, nothing to create. */
  readonly unchanged: { resolved: ResolvedIngredient; match: ListItem }[];
  /** The request's order, so the response reads as the user's selection did. */
  readonly order: readonly string[];
}

/**
 * §7.3 step 6's duplicate rule, in its three states.
 *
 * Absent → create. Present and **unchecked** → extend that row's label and create nothing; it
 * is still on the shopping list, so a second line is noise. Present and **checked** → create,
 * because a checked row means it was already bought and the user needs it again.
 *
 * A fourth case falls out of replay: an unchecked match that **already carries this exact
 * label** needs no write at all. That keeps a re-tap after a lost response from turning
 * `Sunday dinner` into `Sunday dinner · Sunday dinner`, which is not an extension but the
 * same fact twice. Segments are compared whole, so `Sunday` does not match inside
 * `Sunday dinner`.
 *
 * The match is on a case-insensitive, trimmed title. Two ingredients in one request that
 * normalise to the same title are handled the same way: the first claims the match, and the
 * second finds no unchecked row left to join and creates one — the same answer the two taps
 * would have got as separate requests.
 */
function classify(
  selected: readonly ResolvedIngredient[],
  existing: readonly ListItem[],
  sourceLabel: string,
): Plan {
  const unchecked = new Map<string, ListItem>();
  for (const item of existing) {
    if (item.checked) continue;
    const key = normalise(item.title);
    if (!unchecked.has(key)) unchecked.set(key, item);
  }

  const creates: ResolvedIngredient[] = [];
  const extended: { resolved: ResolvedIngredient; match: ListItem }[] = [];
  const unchanged: { resolved: ResolvedIngredient; match: ListItem }[] = [];
  for (const resolved of selected) {
    const key = normalise(resolved.title);
    const match = unchecked.get(key);
    if (match === undefined) {
      creates.push(resolved);
      continue;
    }
    unchecked.delete(key);
    if (alreadyLabelled(match, sourceLabel)) unchanged.push({ resolved, match });
    else extended.push({ resolved, match });
  }
  return { creates, extended, unchanged, order: selected.map((row) => row.ingredientId) };
}

function normalise(title: string): string {
  return title.trim().toLowerCase();
}

function alreadyLabelled(item: ListItem, label: string): boolean {
  if (item.sourceLabel === undefined) return false;
  return item.sourceLabel.split(' · ').includes(label);
}

/**
 * The labels on this list that belong to **other** meals (§7.5 rule 5).
 *
 * Rule 5 disambiguates two meals that produced the same words. A row this meal wrote is not
 * another meal, and a row with no `sourceActivityId` was added by hand and has no label at
 * all, so neither can trigger it. Each row's label is split back into its segments, because
 * an extended row carries several and any one of them may be the collision.
 */
function labelsFromOtherMeals(items: readonly ListItem[], activityId: string): string[] {
  const labels = new Set<string>();
  for (const item of items) {
    if (item.sourceActivityId === undefined || item.sourceActivityId === activityId) {
      continue;
    }
    if (item.sourceLabel === undefined) continue;
    for (const segment of item.sourceLabel.split(' · ')) labels.add(segment);
  }
  return [...labels];
}

/**
 * The wall date rules 1–3 measure from, in the zone the meal itself is scheduled in.
 *
 * `provenanceLabel` takes `today` rather than reading a clock, and this is where that
 * decision is paid for. The meal's own timezone is the right frame: `Sunday dinner` means the
 * Sunday of that dinner, not the Sunday of whichever machine served the request. An
 * unscheduled meal takes rule 4 and never reaches the comparison, so the request instant is a
 * safe frame for the one case with no zone to borrow.
 */
function today(activity: Activity, now: string): string {
  const timezone = activity.schedule?.timezone;
  if (timezone === undefined) return now.slice(0, 10);
  return toWallDate(now as Instant, timezone as TimeZone);
}

/** The response, in the order the ingredients were sent, whatever happened to each. */
function assemble(
  listId: string,
  sourceLabel: string,
  activityUpdatedAt: string,
  plan: Plan,
  labelled: readonly ListItem[],
  created: readonly ListItem[],
): AddedIngredients {
  const outcomes = new Map<string, { outcome: 'created' | 'labelled'; item: ListItem }>();
  for (const [index, row] of plan.extended.entries()) {
    const item = labelled[index];
    if (item !== undefined) {
      outcomes.set(row.resolved.ingredientId, { outcome: 'labelled', item });
    }
  }
  /** Already carried this label, so it reports as `labelled` with the row untouched. */
  for (const row of plan.unchanged) {
    outcomes.set(row.resolved.ingredientId, { outcome: 'labelled', item: row.match });
  }
  for (const [index, resolved] of plan.creates.entries()) {
    const item = created[index];
    if (item !== undefined) {
      outcomes.set(resolved.ingredientId, { outcome: 'created', item });
    }
  }
  return {
    listId,
    sourceLabel,
    activityUpdatedAt,
    ingredients: plan.order.flatMap((ingredientId) => {
      const row = outcomes.get(ingredientId);
      return row === undefined
        ? []
        : [{ ingredientId, outcome: row.outcome, item: row.item }];
    }),
  };
}

/**
 * The destination, and the one thing that disqualifies it.
 *
 * `collection` only. A `watch` or `meals` list has typed `details` every item must carry
 * (`plans-and-lists.md` §5.7), and an ingredient has none to give — writing a bare title into
 * a watch list would produce a row its own renderer rejects. §7.3 resolves the `groceries`
 * slot, which only a `collection` ever holds.
 */
async function loadCollection(
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
  if (list.behaviour !== 'collection') refuse('listId', NOT_A_COLLECTION);
  return list;
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
