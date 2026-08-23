import type { ListTemplate } from '../types/list.js';

/**
 * The list template catalogue (`plans-and-lists.md` §5.3, `data-model.md` §4.6 "Templates",
 * ADR-032).
 *
 * A plain, frozen array. **This is the file someone edits to add "Books to read", and
 * editing it must be the entire change** — no schema change, no branch, no migration. Every
 * string here is owned by the canonical table in `plans-and-lists.md` §5.3; nothing in this
 * file is prose invented during implementation, and the test beside it asserts every field of
 * every record against that table.
 *
 * ## Seeds, not live references
 *
 * `POST /v1/lists` resolves the selected record once and **copies** `behaviour`,
 * `capabilities`, `slot`, `icon` and `emptyStateCopy` onto the `List`. `templateKey` is then
 * provenance only. Nothing renders from `LIST_TEMPLATES[list.templateKey]`: a list renders
 * from its own row, so a shipped change to this array can never alter a list somebody is
 * standing in a shop reading. The dependency-cruiser rule `list-templates-are-creation-data`
 * limits who may import this module to the creation service, the templates route and the
 * creation-choice projection — never a repository, a renderer or a stored-List read path.
 *
 * ## The order is the contract
 *
 * The explicit style chooser renders this array in this order, with nothing selected,
 * recommended, pinned, reordered or hidden (`plans-and-lists.md` §5.4). There is no matcher,
 * ranking or fallback from a title anywhere; `simple-list` is a choice the user taps, not a
 * default.
 *
 * `icon` values are the canonical keys from the table. Not all of them have a glyph in
 * `packages/ui/src/icons/` yet; that is the renderer's inventory to extend, and this package
 * is a leaf that cannot check it (`plans-and-lists.md` §5.3 "icons are the one part of a
 * template that is not pure config").
 */
export const LIST_TEMPLATES = Object.freeze([
  {
    templateKey: 'simple-list',
    chooserLabel: 'Blank',
    summary: 'A plain list',
    defaultTitle: 'Simple list',
    icon: 'list',
    behaviour: 'collection',
    capabilities: { checkable: false, supportsLocation: false },
    slot: null,
    emptyStateCopy: 'Add the first item.',
  },
  {
    templateKey: 'checklist',
    chooserLabel: 'Checklist',
    summary: 'Items have checkboxes',
    defaultTitle: 'Checklist',
    icon: 'check-square',
    behaviour: 'collection',
    capabilities: { checkable: true, supportsLocation: false },
    slot: null,
    emptyStateCopy: 'Add something to check off.',
  },
  {
    templateKey: 'groceries',
    chooserLabel: 'Groceries',
    summary: 'Checkboxes for shopping',
    defaultTitle: 'Groceries',
    icon: 'cart',
    behaviour: 'collection',
    capabilities: { checkable: true, supportsLocation: false },
    slot: 'groceries',
    emptyStateCopy: 'Add something to buy.',
  },
  {
    templateKey: 'shopping',
    chooserLabel: 'Shopping',
    summary: 'Things to buy',
    defaultTitle: 'Shopping',
    icon: 'bag',
    behaviour: 'collection',
    capabilities: { checkable: true, supportsLocation: false },
    slot: null,
    emptyStateCopy: 'Add something to shop for.',
  },
  {
    templateKey: 'packing',
    chooserLabel: 'Packing',
    summary: 'A checklist for a trip',
    defaultTitle: 'Packing',
    icon: 'suitcase',
    behaviour: 'collection',
    capabilities: { checkable: true, supportsLocation: false },
    slot: null,
    emptyStateCopy: 'Add something to pack.',
  },
  {
    templateKey: 'restaurants-to-try',
    chooserLabel: 'Restaurants to try',
    summary: 'Places and checkboxes',
    defaultTitle: 'Restaurants to try',
    icon: 'bowl',
    behaviour: 'collection',
    capabilities: { checkable: true, supportsLocation: true },
    slot: null,
    emptyStateCopy: 'Add a restaurant to try.',
  },
  {
    templateKey: 'bars-to-try',
    chooserLabel: 'Bars to try',
    summary: 'Places and checkboxes',
    defaultTitle: 'Bars to try',
    icon: 'glass',
    behaviour: 'collection',
    capabilities: { checkable: true, supportsLocation: true },
    slot: null,
    emptyStateCopy: 'Add a bar to try.',
  },
  {
    templateKey: 'coffee-shops',
    chooserLabel: 'Coffee shops',
    summary: 'Places without checkboxes',
    defaultTitle: 'Coffee shops',
    icon: 'cup',
    behaviour: 'collection',
    capabilities: { checkable: false, supportsLocation: true },
    slot: null,
    emptyStateCopy: 'Add a coffee shop.',
  },
  {
    templateKey: 'places-to-visit',
    chooserLabel: 'Places to visit',
    summary: 'Places and checkboxes',
    defaultTitle: 'Places to visit',
    icon: 'map-pin',
    behaviour: 'collection',
    capabilities: { checkable: true, supportsLocation: true },
    slot: null,
    emptyStateCopy: 'Add a place to visit.',
  },
  {
    templateKey: 'date-ideas',
    chooserLabel: 'Date ideas',
    summary: 'Places and ideas',
    defaultTitle: 'Date ideas',
    icon: 'heart',
    behaviour: 'collection',
    capabilities: { checkable: false, supportsLocation: true },
    slot: null,
    emptyStateCopy: 'Add a date idea.',
  },
  {
    templateKey: 'favourite-restaurants',
    chooserLabel: 'Favourite restaurants',
    summary: 'Places without checkboxes',
    defaultTitle: 'Favourite restaurants',
    icon: 'star',
    behaviour: 'collection',
    capabilities: { checkable: false, supportsLocation: true },
    slot: null,
    emptyStateCopy: 'Add a restaurant you love.',
  },
  {
    templateKey: 'books-to-read',
    chooserLabel: 'Books to read',
    summary: 'Books with checkboxes',
    defaultTitle: 'Books to read',
    icon: 'book',
    behaviour: 'collection',
    capabilities: { checkable: true, supportsLocation: false },
    slot: null,
    emptyStateCopy: 'Add a book to read.',
  },
  {
    templateKey: 'gift-ideas',
    chooserLabel: 'Gift ideas',
    summary: 'Ideas without checkboxes',
    defaultTitle: 'Gift ideas',
    icon: 'gift',
    behaviour: 'collection',
    capabilities: { checkable: false, supportsLocation: false },
    slot: null,
    emptyStateCopy: 'Add a gift idea.',
  },
  {
    templateKey: 'watchlist',
    chooserLabel: 'Watchlist',
    summary: 'Status and progress',
    defaultTitle: 'Watchlist',
    icon: 'play-rect',
    behaviour: 'watch',
    capabilities: { checkable: false, supportsLocation: false },
    slot: 'watch',
    emptyStateCopy: 'Add a movie or show.',
  },
  {
    templateKey: 'movies-to-watch',
    chooserLabel: 'Movies to watch',
    summary: 'Status for movies',
    defaultTitle: 'Movies to watch',
    icon: 'film',
    behaviour: 'watch',
    capabilities: { checkable: false, supportsLocation: false },
    slot: 'watch',
    emptyStateCopy: 'Add a movie.',
  },
  {
    templateKey: 'tv-shows',
    chooserLabel: 'TV shows',
    summary: 'Episode progress',
    defaultTitle: 'TV shows',
    icon: 'play-rect',
    behaviour: 'watch',
    capabilities: { checkable: false, supportsLocation: false },
    slot: 'watch',
    emptyStateCopy: 'Add a TV show.',
  },
  {
    templateKey: 'meals-to-try',
    chooserLabel: 'Meals to try',
    summary: 'Ingredients on each item',
    defaultTitle: 'Meals to try',
    icon: 'bowl',
    behaviour: 'meals',
    capabilities: { checkable: false, supportsLocation: false },
    slot: 'meals',
    emptyStateCopy: 'Add a meal to try.',
  },
] as const satisfies readonly ListTemplate[]);
