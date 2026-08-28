import type {
  List,
  ListItemDetails,
  ListItemPlanState,
  ListItemView,
} from '@od/shared/types';

/**
 * What a list row renders, decided from the list's own fields and the item (§P3-28, §5.7).
 *
 * Pure, and separate from the component for the reason `listDetail.ts` is: these are the
 * decisions that must not be got wrong, and a rule expressed inside JSX can only be tested by
 * rendering it into a tree and querying for absence.
 *
 * ## The two inputs, and nothing else
 *
 * `behaviour` and `capabilities` come off the **List row** — the values copied onto it at
 * creation (ADR-032) — and everything else comes off the item. There is no `templateKey` here
 * and no lookup that could reach the catalogue; the CI grep asserts the absence in the
 * component, and this module is where the absence is actually load-bearing.
 */

/** The list fields a row may read. Narrowed to two, so nothing else is reachable. */
export type RowList = Pick<List, 'behaviour' | 'capabilities'>;

/**
 * The checkbox gate, both halves.
 *
 * A `watch` list can carry a stored `checkable: true` that a behaviour change left behind, and
 * a `collection` can have the flag off. Either alone hides the control — and hiding is all it
 * does: `item.checked` is **retained** underneath, so turning the capability back on restores
 * exactly what was there (§5.5, §P3-08's edge cases).
 */
export function showsCheckbox(list: RowList): boolean {
  return list.behaviour === 'collection' && list.capabilities.checkable;
}

/**
 * The location gate, all three parts: the behaviour, the capability, and a stored place.
 *
 * Retained the same way. A list converted to `watch` keeps every `location` it had; the row
 * simply stops drawing the subtitle and its maps target (§5.7).
 */
export function showsLocation(list: RowList, item: ListItemView): boolean {
  return (
    list.behaviour === 'collection' &&
    list.capabilities.supportsLocation &&
    item.location !== undefined
  );
}

/**
 * `S2 E4`, for a show.
 *
 * Movies render no progress line (§5.7, §P3-31): there is no season to count and an episode
 * number on a film is a category error rather than a missing value. A show with neither number
 * yet renders nothing rather than `S? E?`.
 */
export function watchProgress(item: ListItemView): string | undefined {
  const details = item.details;
  if (details?.behaviour !== 'watch' || details.mediaKind !== 'show') return undefined;
  const parts = [
    details.season === undefined ? undefined : `S${String(details.season)}`,
    details.episode === undefined ? undefined : `E${String(details.episode)}`,
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? undefined : parts.join(' ');
}

/** The same progress, spoken in full — §6.2's `season 2 episode 4`, never `S2 E4`. */
export function spokenWatchProgress(item: ListItemView): string | undefined {
  const details = item.details;
  if (details?.behaviour !== 'watch' || details.mediaKind !== 'show') return undefined;
  const parts = [
    details.season === undefined ? undefined : `season ${String(details.season)}`,
    details.episode === undefined ? undefined : `episode ${String(details.episode)}`,
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? undefined : parts.join(' ');
}

/**
 * The status chip's label — §5.2's own vocabulary, so the chip and P3-31's group heading say
 * the same words about the same item.
 *
 * `undefined` for an item whose typed details are missing. That is **invalid data, not a
 * default**: a committed `watch` item without them is rejected by the schema upstream, and a
 * renderer that supplied `want` would turn a bad response into a plausible-looking row
 * (§P3-28's edge cases).
 */
export function watchStatusLabel(item: ListItemView): string | undefined {
  const details = item.details;
  if (details?.behaviour !== 'watch') return undefined;
  return WATCH_STATUS_LABELS[details.watchStatus];
}

/**
 * Derived from the shared union rather than re-declared, so a fourth status added in
 * `packages/shared` fails the `satisfies` below instead of quietly rendering nothing.
 */
export type WatchStatus = Extract<ListItemDetails, { behaviour: 'watch' }>['watchStatus'];

/**
 * §5.2's three words, in the one place they live.
 *
 * The row's chip, P3-31's group headings and P3-29's any-to-any status control all say them,
 * and a second copy is how one of the three comes to read `Want` in one place and `Want to
 * watch` in another.
 *
 * **Keyed rather than ordered**, because there are two orders and neither belongs to a lookup
 * table: §5.2's display order is `Watching · Want to watch · Watched`, which `watchSections.ts`
 * states, and §8.1's transition order is `want -> watching -> watched`, which
 * {@link WATCH_STATUSES} states for a control that has to enumerate them.
 */
export const WATCH_STATUS_LABELS = {
  want: 'Want to watch',
  watching: 'Watching',
  watched: 'Watched',
} as const satisfies Record<WatchStatus, string>;

/** §8.1's transition order, for a control that offers all three. Not §5.2's display order. */
export const WATCH_STATUSES = ['want', 'watching', 'watched'] as const;

/**
 * The ingredient count on a `meals` row.
 *
 * Zero is a count, so it is stated. `ingredients` is legitimately absent on a meal nobody has
 * filled in yet — unlike the typed `details` object itself, whose absence is invalid — and a
 * row that said nothing at all would leave the only meals-specific affordance invisible.
 */
export function ingredientCount(item: ListItemView): string | undefined {
  const details = item.details;
  if (details?.behaviour !== 'meals') return undefined;
  const count = details.ingredients?.length ?? 0;
  if (count === 0) return 'No ingredients';
  return `${String(count)} ${count === 1 ? 'ingredient' : 'ingredients'}`;
}

/**
 * Whether this row may show a caller state line at all (§6.2, §P3-28's input table).
 *
 * **Link presence is never display eligibility.** The pointer is retained across an
 * unschedule and the line disappears with the date, returning when the same Activity is
 * rescheduled. So the question this answers is structural — *is there a hydrated Activity with
 * a date behind this row* — and it is the row's to answer.
 *
 * What the line then **says** is P3-34's: the verb per `status` and Plan kind, the relative
 * date format, and the `Cancelled` arm that has no date to show. Splitting it here keeps the
 * product rule that governs visibility in the component that owns the layout, and the wording
 * in the task that owns the wording.
 */
export function mayShowPlanStateLine(viewerPlan: ListItemPlanState | undefined): boolean {
  return viewerPlan?.schedule?.date !== undefined;
}

/**
 * §6.2's row-body label, composed in its reading order.
 *
 * The four list-item rows in that table are one row's worth of vocabulary between them:
 * `Chicken, from Sunday dinner`, `Zahav, 237 St James Place`, and
 * `Severance, watching, season 2 episode 4`. A row that carries several of those carries
 * several clauses, in this order, because that is the order the table gives them.
 *
 * The state line and the address line are **not** in here. Each is its own element with its
 * own label, so speaking their text again in the body would announce it twice.
 */
export function rowBodyLabel(list: RowList, item: ListItemView): string {
  const place =
    showsLocation(list, item) && item.location !== undefined
      ? (item.location.address ?? item.location.label)
      : undefined;
  const status = watchStatusLabel(item)?.toLowerCase();
  const progress = spokenWatchProgress(item);
  return [
    item.title,
    place,
    status,
    progress,
    ingredientCount(item)?.toLowerCase(),
    item.sourceLabel === undefined ? undefined : `from ${item.sourceLabel}`,
  ]
    .filter((part): part is string => part !== undefined && part !== '')
    .join(', ');
}

/** §6.2's checkbox label: the item, and its state spoken rather than implied by colour. */
export function checkboxLabel(item: ListItemView): string {
  return `${item.title}, ${item.checked ? 'checked' : 'not checked'}`;
}
