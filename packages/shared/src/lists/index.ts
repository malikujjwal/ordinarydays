/**
 * `@od/shared/lists` — the list template catalogue and, from P3-07, its creation-choice
 * projection.
 *
 * **Deliberately not re-exported from the root barrel.** `LIST_TEMPLATES` is creation-time
 * data with an import boundary (`list-templates-are-creation-data` in
 * `.dependency-cruiser.cjs`): a repository, renderer or stored-List read path must not be
 * able to reach it, and a root re-export would hand it to every `import … from '@od/shared'`.
 * The same reasoning keeps `./client` off the root barrel.
 *
 * `listTemplateChoices` is the projection the creation sheet renders, and is the only one of
 * the two a client should normally reach for: it carries the displayed fields and nothing a
 * renderer could mistake for stored-List state.
 */

export { type ListTemplateChoice, listTemplateChoices } from './templateChoices.js';
export { LIST_TEMPLATES } from './templates.js';
