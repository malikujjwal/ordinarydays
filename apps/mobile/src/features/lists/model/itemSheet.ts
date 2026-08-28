import type { PatchListItemInput } from '@od/shared/client';
import type { ListItemDetails, ListItemView } from '@od/shared/types';
import type { RowList } from './listItemRow';

/**
 * What the item sheet renders and what each edit sends
 * ([`plans-and-lists.md`](../../../../../docs/01-product/plans-and-lists.md) §5.6, §5.7,
 * §7.5, §8.1; §P3-29).
 *
 * Pure and separate from the component for `listItemRow.ts`'s reason, which is sharper here:
 * §P3-29's required test is a **render matrix** asserting that a field is *absent* — "a
 * location field on a `supportsLocation: false` list is absent, not disabled" — and absence
 * expressed inside JSX can only be tested by rendering a tree and querying for a thing that is
 * not there. Deciding it here makes the matrix a table of return values.
 *
 * ## Two inputs, and never the template key
 *
 * `behaviour` and `capabilities` off the **List row** (ADR-032), everything else off the item.
 * The same `RowList` the row renderer takes, imported rather than restated, so the sheet and
 * the row that opened it can never disagree about what a list is. `listIndex.test.ts`'s grep
 * covers this directory.
 *
 * ## One PATCH per field, and no `If-Match`
 *
 * Every builder below returns the **one** field it changes (§5.11.5: item writes carry no
 * `If-Match` and last write wins per field). `details` is the exception that proves it: it is a
 * strict discriminated union on the wire, so changing `watchStatus` alone still sends the whole
 * typed object. That is one field — `details` — carrying its complete value, not a
 * read-modify-write across several.
 */

/** The list's own two fields, exactly as the row renderer takes them. */
export type { RowList };

/**
 * Which §5.7 groups this sheet draws. Every flag is a **product** decision, not a layout one.
 *
 * `title` and `note` are absent from this shape because they are unconditional: §5.7's first
 * paragraph gives them to "every item, on every behaviour", and a flag that is always `true`
 * invites a caller to ask.
 */
export interface ItemSheetFieldSet {
  /** Place label and optional address, tapping through to the platform maps app. */
  readonly place: boolean;
  /** `mediaKind`, the any-to-any status control, and `Mark as watched`. */
  readonly watch: boolean;
  /** Season and episode. **Shows only** — an episode number on a film is a category error. */
  readonly progress: boolean;
  /** The typed ingredient rows. */
  readonly ingredients: boolean;
}

/**
 * The §5.7 matrix, as a value.
 *
 * ## Why `place` does not ask whether the item has one
 *
 * `showsLocation` on the row requires a stored `location`, because a row with no place has no
 * subtitle to draw. The sheet is where a place is **added**, so the gate is the list's
 * capability alone. Retention still holds from the other side: a `location` on a list that is
 * no longer a `collection` is hidden and kept, and turning the capability back on brings it
 * back (§5.5).
 *
 * ## Why `watch` asks the item and `ingredients` does not
 *
 * A `watch` item's `watchStatus` is **required** by the schema, so an item that arrives without
 * typed details is invalid data rather than an empty state — and a status control offered over
 * it would have to invent `want`, turning a bad response into a plausible-looking row
 * (§P3-28's rule, applied to the editor). `meals` has no such field: `ingredients` is
 * legitimately absent on a meal nobody has filled in yet, which is a real empty state and the
 * one this editor exists to fill.
 */
export function itemSheetFields(list: RowList, item: ListItemView): ItemSheetFieldSet {
  const watch = list.behaviour === 'watch' && watchDetails(item) !== undefined;
  return {
    place: list.behaviour === 'collection' && list.capabilities.supportsLocation,
    watch,
    progress: watch && watchDetails(item)?.mediaKind === 'show',
    ingredients: list.behaviour === 'meals',
  };
}

/** The item's typed watch details, or `undefined` when it has none to read. */
export function watchDetails(
  item: ListItemView,
): Extract<ListItemDetails, { behaviour: 'watch' }> | undefined {
  return item.details?.behaviour === 'watch' ? item.details : undefined;
}

/**
 * One editable ingredient row.
 *
 * `quantity` is a string here and optional on the wire: an editor needs the emptied box to be
 * representable, and `''` is what an emptied box is.
 */
export interface IngredientRow {
  /** The stable `ing_` embedded-row identity, kept across edits (`data-model.md` §8). */
  readonly ingredientId: string;
  readonly name: string;
  readonly quantity: string;
}

/**
 * The item's ingredients as editable rows.
 *
 * `addedToListId` is **dropped on the way in**, and that is load-bearing rather than tidy:
 * `listItemDetailsInput`'s meals arm is strict and rejects it, because it records that the
 * authorised add-to-list action ran and a client that could set it would be fabricating that
 * for any well-formed id. So a round trip through this editor must not carry it back.
 */
export function ingredientRows(item: ListItemView): readonly IngredientRow[] {
  if (item.details?.behaviour !== 'meals') return [];
  return (item.details.ingredients ?? []).map((ingredient) => ({
    ingredientId: ingredient.ingredientId,
    name: ingredient.name,
    quantity: ingredient.quantity ?? '',
  }));
}

/** §7.5's provenance row, when the item carries one. */
export interface ItemProvenance {
  /** The exact stored `sourceLabel`, never recomputed (§7.5). */
  readonly label: string;
  /** Absent on provenance that names no Activity; the row is then plain text from the start. */
  readonly sourceActivityId?: string;
}

/**
 * §7.5's provenance, or `undefined` when there is none.
 *
 * The label is the **stored** `sourceLabel` — computed once at creation so it stays truthful
 * after the meal is rescheduled or deleted — and nothing here splits, parses or reconstructs
 * it. A rule-5 label legitimately contains a middle dot.
 *
 * `sourceActivityId` decides only whether the row *offers* navigation. Whether it still
 * resolves is not on the wire at all, and is learned the way §7.5 implies: by trying.
 */
export function itemProvenance(item: ListItemView): ItemProvenance | undefined {
  if (item.sourceLabel === undefined) return undefined;
  return {
    label: item.sourceLabel,
    ...(item.sourceActivityId === undefined
      ? {}
      : { sourceActivityId: item.sourceActivityId }),
  };
}

/** `From Chicken tacos`, as the row and its accessible name both say it. */
export function provenanceLine(provenance: ItemProvenance): string {
  return `From ${provenance.label}`;
}

/** The title edit. Trimmed, and refused empty — `title` carries a `min(1)` on the wire. */
export function titlePatch(next: string): PatchListItemInput | undefined {
  const title = next.trim();
  return title === '' ? undefined : { title };
}

/** The note edit. Emptied means **cleared**, which is `null` rather than `''` or absent. */
export function notePatch(next: string): PatchListItemInput {
  const note = next.trim();
  return { note: note === '' ? null : note };
}

/**
 * The place edit — one field, `location`, carrying both halves.
 *
 * Clearing the label clears the place: an address with no label is not a place a row could
 * draw, and §5.7 gives the label as the thing and the address as its optional detail.
 *
 * `lat` and `lng` are carried through from the item rather than dropped. No v1 surface collects
 * them, so an edit never invents them — and never removes them either, because they are not
 * this field's to remove.
 */
export function placePatch(
  item: ListItemView,
  label: string,
  address: string,
): PatchListItemInput {
  const trimmedLabel = label.trim();
  const trimmedAddress = address.trim();
  if (trimmedLabel === '') return { location: null };
  const { lat, lng } = item.location ?? {};
  return {
    location: {
      label: trimmedLabel,
      ...(trimmedAddress === '' ? {} : { address: trimmedAddress }),
      ...(lat === undefined ? {} : { lat }),
      ...(lng === undefined ? {} : { lng }),
    },
  };
}

type WatchFields = Omit<Extract<ListItemDetails, { behaviour: 'watch' }>, 'behaviour'>;

/**
 * What one watch control changes. `behaviour` is not among them — it is the list's.
 *
 * Each key is explicitly `| undefined` rather than merely optional, because under
 * `exactOptionalPropertyTypes` those are different statements and the difference is the
 * feature: an emptied `Season` box passes `{ season: undefined }`, which **clears** the field,
 * while omitting the key would mean the control had nothing to say about it.
 */
export type WatchChange = { [K in keyof WatchFields]?: WatchFields[K] | undefined };

/**
 * A change to one watch field, sent as the whole typed `details`.
 *
 * `undefined` when the item has no watch details to change — the invalid-data case
 * {@link itemSheetFields} already refuses to draw a control for. Returning a patch there would
 * mean inventing the `watchStatus` the schema requires.
 *
 * A `movie` **keeps** its stored season and episode rather than having them stripped. Hiding
 * the fields is what §5.7 asks for, and a media kind toggled by mistake must not cost the
 * progress underneath it — §5.5's retention rule, at field scale.
 */
export function watchPatch(
  item: ListItemView,
  change: WatchChange,
): PatchListItemInput | undefined {
  const current = watchDetails(item);
  if (current === undefined) return undefined;
  const merged = { ...current, ...change };
  return {
    details: {
      behaviour: 'watch',
      /*
       * The one field that cannot be cleared: the schema requires it and §5.2 groups the list
       * by it, so a control that passed `undefined` keeps what is there rather than producing
       * an item the list has no section for.
       */
      watchStatus: merged.watchStatus ?? current.watchStatus,
      ...(merged.mediaKind === undefined ? {} : { mediaKind: merged.mediaKind }),
      ...(merged.season === undefined ? {} : { season: merged.season }),
      ...(merged.episode === undefined ? {} : { episode: merged.episode }),
    },
  };
}

/**
 * The ingredient rows, sent as the whole typed `details`.
 *
 * A row with an empty name is dropped rather than rejected: the editor's blank row is how a new
 * ingredient starts, and someone who opened one and changed their mind has not made a mistake
 * to be told about.
 */
export function ingredientsPatch(rows: readonly IngredientRow[]): PatchListItemInput {
  const ingredients = rows
    .map((row) => ({
      ingredientId: row.ingredientId,
      name: row.name.trim(),
      quantity: row.quantity.trim(),
    }))
    .filter((row) => row.name !== '')
    .map((row) => ({
      ingredientId: row.ingredientId,
      name: row.name,
      ...(row.quantity === '' ? {} : { quantity: row.quantity }),
    }));
  return { details: { behaviour: 'meals', ingredients } };
}

/**
 * Parses a typed season or episode box.
 *
 * `undefined` for an emptied box and for anything that is not a whole number, which the schema
 * bounds anyway. The two are one outcome on purpose: the field simply carries no value, and a
 * half-typed `1` on the way to `12` must not produce a rejected write.
 */
export function watchNumber(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed === '' || !/^\d+$/.test(trimmed)) return undefined;
  const value = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(value) ? value : undefined;
}
