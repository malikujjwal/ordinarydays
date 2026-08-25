import { MAX_LIST_ITEMS } from '@od/shared';
import { formatIngredientTitle, provenanceLabel } from '@od/shared/lists';
import type { AddIngredientsToListInput } from '@od/shared/schemas';
import type { Activity, List, ListItem, MealIngredient } from '@od/shared/types';
import { AppError } from '../lib/errors.js';
import type { IdempotencyReceipt } from '../lib/idempotency.js';
import {
  type IngredientAddition,
  recordIngredientsAddedToList,
} from '../repositories/activityRepository.js';
import { writeReceiptOnly } from '../repositories/idempotencyRepository.js';
import {
  createListItems,
  extendItemSourceLabel,
  getListMeta,
  type ListAccessGrant,
  ListFullError,
  ListMutationRetryExhaustedError,
  ListNotFoundError,
  ListRankRepairRequiredError,
  ListReadFenceError,
  type NewListItem,
  newItemId,
  readAllListItems,
} from '../repositories/listRepository.js';
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
 * ## Order of writes, and why it is this order
 *
 * Three steps, and only the middle one can duplicate anything:
 *
 * 1. **Extend the labels** of existing unchecked rows. Idempotent by
 *    {@link alreadyLabelled}: a segment a row already carries is not appended twice.
 * 2. **Create the new rows**, carrying the idempotency receipt. This is the commit point.
 * 3. **Record `addedToListId`** on the source ingredients. Idempotent by construction.
 *
 * Everything before the commit point is safe to re-run, which is what makes a crash
 * recoverable: no receipt was stored, so the client's retry replays the whole action and the
 * re-run is a no-op up to the point it failed. A crash *after* the commit point leaves items
 * on the list that the meal does not yet show as `Added` — the user taps again, §7.3's
 * duplicate rule recognises the unchecked rows it just made, and step 3 lands. The failure
 * mode is one redundant tap, in exchange for never creating a row twice.
 */

const NOT_A_MEAL = 'Only a meal has ingredients to add.';
const NOT_A_COLLECTION = 'Ingredients can only be added to a simple list.';
const STALE_INGREDIENT =
  'Some of those ingredients have changed. Reopen the meal and try again.';
const BUSY = 'That list is busy. Try again.';
const LIST_FULL = 'List is full.';

/** A selected ingredient, resolved against the meal's current array. */
interface ResolvedIngredient {
  readonly ingredientId: string;
  /** Where it sits **now**. Only ever used alongside its id, as a write condition. */
  readonly index: number;
  readonly ingredient: MealIngredient;
  readonly title: string;
  readonly itemId?: string;
}

interface PlacedItem {
  readonly resolved: ResolvedIngredient;
  readonly item: ListItem;
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
  readonly ingredients: readonly {
    readonly ingredientId: string;
    readonly outcome: 'created' | 'labelled';
    readonly item: ListItem;
  }[];
}

/**
 * `POST /v1/activities/:id/ingredients/add-to-list`.
 *
 * @param receiptFor built from the rows actually written, so a replay returns the ids that
 * were created — the same reason `createListItems` takes a callback rather than a prebuilt
 * receipt (`listRepository.ts`).
 */
export async function addIngredientsToList(
  userId: string,
  activityId: string,
  input: AddIngredientsToListInput,
  now: string,
  receiptFor?: (result: AddedIngredients) => IdempotencyReceipt,
): Promise<AddedIngredients> {
  const { activity } = await assertActivityAccess(userId, activityId, 'owner');
  if (activity.type !== 'meal') refuse('activityId', NOT_A_MEAL);

  const access = await assertListAccess(userId, input.listId, 'write');
  const list = await mapped(() =>
    loadCollection(userId, input.listId, access.index, now),
  );

  const selected = resolveSelected(activity, input);
  const existing = await mapped(() =>
    withListWorkDrain(
      userId,
      input.listId,
      access.index,
      () => readAllListItems(userId, input.listId, access.index),
      now,
    ),
  );

  const label = provenanceLabel(
    labelSource(activity),
    labelsFromOtherMeals(existing, activityId),
    today(activity, now),
  );

  const plan = classify(selected, existing);
  assertCapacity(list, plan.creates.length);

  // Step 1 — see the ordering note above. Every one of these is a no-op on a second run.
  const labelled: PlacedItem[] = [];
  for (const { resolved, match } of plan.extended) {
    const item = alreadyLabelled(match, label)
      ? match
      : await mapped(() =>
          extendItemSourceLabel(userId, input.listId, access.index, match, label, now),
        );
    labelled.push({ resolved, item });
  }

  // Step 2 — the commit point.
  const created = await createRows(
    userId,
    input.listId,
    access.index,
    plan.creates,
    { activityId, label, now },
    receiptFor === undefined
      ? undefined
      : (rows) => receiptFor(assemble(input.listId, label, plan.order, labelled, rows)),
  );

  const result = assemble(input.listId, label, plan.order, labelled, created);

  // Step 3 — after the commit point, and idempotent because of it.
  await recordIngredientsAddedToList(
    activityId,
    input.listId,
    selected.map(
      (resolved): IngredientAddition => ({
        index: resolved.index,
        ingredientId: resolved.ingredientId,
      }),
    ),
  );

  return result;
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
 * write condition (`recordIngredientsAddedToList`).
 *
 * **A missing id fails the whole request** (§P3-17). The row was deleted or replaced, so the
 * thing the user selected no longer exists; adding the remaining ones would silently deliver
 * a different order than the one they confirmed, and resolving it to whatever now sits at
 * that position is precisely the position-is-identity bug the id removes.
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
  return input.ingredients.map((selection, position) => {
    const path = `ingredients.${String(position)}.ingredientId`;
    if (seen.has(selection.ingredientId)) refuse(path, STALE_INGREDIENT);
    seen.add(selection.ingredientId);

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

interface Plan {
  readonly creates: ResolvedIngredient[];
  readonly extended: { resolved: ResolvedIngredient; match: ListItem }[];
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
 * The match is on a case-insensitive, trimmed title. Two ingredients in one request that
 * normalise to the same title are handled the same way: the first claims the match, and the
 * second finds no unchecked row left to join and creates one — the same answer the two taps
 * would have got as separate requests.
 */
function classify(
  selected: readonly ResolvedIngredient[],
  existing: readonly ListItem[],
): Plan {
  const unchecked = new Map<string, ListItem>();
  for (const item of existing) {
    if (item.checked) continue;
    const key = normalise(item.title);
    if (!unchecked.has(key)) unchecked.set(key, item);
  }

  const creates: ResolvedIngredient[] = [];
  const extended: { resolved: ResolvedIngredient; match: ListItem }[] = [];
  for (const resolved of selected) {
    const key = normalise(resolved.title);
    const match = unchecked.get(key);
    if (match === undefined) {
      creates.push(resolved);
      continue;
    }
    unchecked.delete(key);
    extended.push({ resolved, match });
  }
  return { creates, extended, order: selected.map((row) => row.ingredientId) };
}

function normalise(title: string): string {
  return title.trim().toLowerCase();
}

/**
 * Whether this row already carries this exact label segment.
 *
 * The guard that makes step 1 replayable. Without it a retried action turns `Sunday dinner`
 * into `Sunday dinner · Sunday dinner`, which is not an extension — it is the same fact
 * twice. Segments are compared whole, so `Sunday` does not match inside `Sunday dinner`.
 */
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
  // `en-CA` formats as `YYYY-MM-DD`, which is the wall-date shape the rules compare.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(now));
}

/** Three transaction items per row plus the fixed three, under the hundred-item ceiling. */
const CREATE_CHUNK = 32;

/**
 * Creates the new rows, in chunks, with the receipt on the last one.
 *
 * The receipt joins the **final** chunk so a crash part-way through stores no successful
 * response and the replay resumes rather than replaying a lie — the same rule
 * `createItemsBulk` follows, and the reason `MAX_INGREDIENTS` (60) cannot be one transaction.
 */
async function createRows(
  userId: string,
  listId: string,
  access: ListAccessGrant,
  rows: readonly ResolvedIngredient[],
  provenance: { activityId: string; label: string; now: string },
  receiptFor?: (created: PlacedItem[]) => IdempotencyReceipt,
): Promise<PlacedItem[]> {
  if (rows.length === 0) {
    // Nothing to write, but the operation still records its receipt — otherwise the next
    // replay re-reads the whole list and re-derives an answer it already gave.
    if (receiptFor !== undefined) await writeReceiptOnly(receiptFor([]));
    return [];
  }

  const planned = rows.map(
    (resolved): NewListItem => ({
      itemId: resolved.itemId ?? newItemId(),
      title: resolved.title,
      checked: false,
      sourceActivityId: provenance.activityId,
      sourceLabel: provenance.label,
    }),
  );

  const placed = (items: readonly ListItem[]): PlacedItem[] =>
    items.map((item, index) => ({ resolved: rows[index] as ResolvedIngredient, item }));

  const created: ListItem[] = [];
  for (let from = 0; from < planned.length; from += CREATE_CHUNK) {
    const chunk = planned.slice(from, from + CREATE_CHUNK);
    const isFinal = from + CREATE_CHUNK >= planned.length;
    const written = await mapped(() =>
      createWithRepair(userId, listId, access, chunk, {
        now: provenance.now,
        ...(isFinal && receiptFor !== undefined
          ? {
              receiptFor: (items: ListItem[]) =>
                receiptFor(placed([...created, ...items])),
            }
          : {}),
      }),
    );
    created.push(...written);
  }

  return placed(created);
}

/** The same repair-once answer every other create path gives an exhausted rank gap. */
async function createWithRepair(
  userId: string,
  listId: string,
  access: ListAccessGrant,
  items: readonly NewListItem[],
  options: { now: string; receiptFor?: (items: ListItem[]) => IdempotencyReceipt },
): Promise<ListItem[]> {
  try {
    return await createListItems(userId, listId, access, items, options);
  } catch (error) {
    if (!(error instanceof ListRankRepairRequiredError)) throw error;
    const repaired = await repairListRanks(userId, listId, access, options.now);
    if (!repaired) throw new AppError('internal', BUSY, undefined, 1);
    return createListItems(userId, listId, access, items, options);
  }
}

/** The response, in the order the user selected, whatever happened to each row. */
function assemble(
  listId: string,
  sourceLabel: string,
  order: readonly string[],
  labelled: readonly PlacedItem[],
  created: readonly PlacedItem[],
): AddedIngredients {
  const outcomes = new Map<string, { outcome: 'created' | 'labelled'; item: ListItem }>();
  for (const row of labelled) {
    outcomes.set(row.resolved.ingredientId, { outcome: 'labelled', item: row.item });
  }
  for (const row of created) {
    outcomes.set(row.resolved.ingredientId, { outcome: 'created', item: row.item });
  }
  return {
    listId,
    sourceLabel,
    ingredients: order.flatMap((ingredientId) => {
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

/** Same precheck, same caveat: the create transaction's own condition is the enforcement. */
function assertCapacity(list: List, adding: number): void {
  if (list.itemCount + adding <= MAX_LIST_ITEMS) return;
  throw new AppError('validation_failed', LIST_FULL, [
    { path: 'ingredients', message: LIST_FULL },
  ]);
}

function refuse(path: string, message: string): never {
  throw new AppError('validation_failed', message, [{ path, message }]);
}

async function mapped<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof ListFullError) {
      throw new AppError('validation_failed', LIST_FULL, [
        { path: 'ingredients', message: LIST_FULL },
      ]);
    }
    if (
      error instanceof ListMutationRetryExhaustedError ||
      error instanceof ListReadFenceError
    ) {
      throw new AppError('internal', BUSY, undefined, 1);
    }
    throw error;
  }
}
