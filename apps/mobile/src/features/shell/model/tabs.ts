/**
 * The three nouns (`overview.md` §3, `interaction-contract.md` §2).
 *
 * **Today · Plans · Lists, in that order, and there is no fourth.** Adding one is a product
 * decision the founder makes, not a routing change — `agent-playbook.md` §10 trigger 8 names
 * it explicitly. The list lives here, as data, so that the assertion "the shell has exactly
 * these three tabs with exactly these labels" is a unit test on a pure module rather than a
 * render test that has to boot a navigator.
 *
 * `name` is the Expo Router route within the `(tabs)` group; `index` is Today, so the app
 * opens at `/` with no redirect.
 */
export interface TabDefinition {
  name: string;
  label: string;
  /** The route's path on web, for the E2E harness and for deep links. */
  path: string;
}

export const tabs: readonly TabDefinition[] = Object.freeze([
  { name: 'index', label: 'Today', path: '/' },
  { name: 'plans', label: 'Plans', path: '/plans' },
  { name: 'lists', label: 'Lists', path: '/lists' },
]);

/**
 * The global Add control's accessible name (`interaction-contract.md` §2).
 *
 * `Add`, not `Add task` and not `New` — the control opens a chooser and commits to nothing,
 * and a label naming an object would be the first place the product implied a default.
 */
export const ADD_LABEL = 'Add';

/** 56 × 56 pt, from the controls table. Not a design preference; a stated hit target. */
export const ADD_SIZE = 56;
