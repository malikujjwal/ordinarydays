/**
 * `@od/shared/lists` — the list template catalogue, its creation-choice projection (P3-07)
 * and, from P3-12, the pure slot-resolution rule.
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
 *
 * `listTemplateSeed` is the other half of creation — the fields a create copies — and is
 * narrower still: `check-forbidden.mjs`'s `template-seed-is-creation-only` limits it to the
 * durable-create path, because reading those fields for a list that already exists is the
 * failure ADR-032 exists to prevent.
 */

export { type ListTemplateSeed, listTemplateSeed } from './creationSeed.js';
export { formatIngredientTitle } from './formatIngredientTitle.js';
export { type LabelSourceMeal, provenanceLabel } from './provenanceLabel.js';
export {
  resolveSlot,
  type SlotEligibleList,
  type SlotResolution,
} from './resolveSlot.js';
export { type ListTemplateChoice, listTemplateChoices } from './templateChoices.js';
export { LIST_TEMPLATES } from './templates.js';
