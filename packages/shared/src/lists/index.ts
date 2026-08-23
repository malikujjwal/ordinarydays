/**
 * `@od/shared/lists` — the list template catalogue and, from P3-07, its creation-choice
 * projection.
 *
 * **Deliberately not re-exported from the root barrel.** `LIST_TEMPLATES` is creation-time
 * data with an import boundary (`list-templates-are-creation-data` in
 * `.dependency-cruiser.cjs`): a repository, renderer or stored-List read path must not be
 * able to reach it, and a root re-export would hand it to every `import … from '@od/shared'`.
 * The same reasoning keeps `./client` off the root barrel.
 */
export { LIST_TEMPLATES } from './templates.js';
