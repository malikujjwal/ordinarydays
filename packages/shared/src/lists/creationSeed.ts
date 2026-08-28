import type { ListTemplate } from '../types/list.js';
import { LIST_TEMPLATES } from './templates.js';

/**
 * The five fields creation **copies** off the selected catalogue record (ADR-032,
 * `plans-and-lists.md` §5.3, §P3-05 step 2).
 *
 * Separate from `templateChoices.ts` on purpose. That projection is what the chooser *shows* —
 * label, summary, icon, default title — and its tests assert it carries no structural field,
 * because the chooser selects creation data and never drives a live list renderer.
 * This is the other half: what a create *writes*, and it exists for exactly one caller.
 *
 * ## Who may call this, and why the list is that short
 *
 * A native list create is accepted into SQLite before it reaches the network, so the device has
 * to store the row the user will look at while offline — and the row's structural and
 * presentation fields are the ones the server will copy from this same record. Resolving them
 * here is the client doing at confirmation what `listCreationService` does on the server.
 *
 * That is the **only** legitimate use. Reading these fields back for a list that already exists
 * is the failure ADR-032 exists to prevent: a template edited a year later would silently change
 * a list somebody is standing in a shop reading. A stored List renders from its own row, always.
 * `scripts/check-forbidden.mjs`'s `template-seed-is-creation-only` keeps the caller list to the
 * durable-create path, the same way `list-templates-are-creation-data` keeps the catalogue
 * itself off every read path.
 *
 * ## Why it takes a key
 *
 * The key comes from the style the user just tapped, not from a stored row. It is a `string`
 * rather than a union because that is what a chooser selection is once it leaves the projection,
 * and an unknown key answers `undefined` rather than falling back: there is no implicit
 * `simple-list`, on the client for the same reason there is none on the server.
 */
export type ListTemplateSeed = Pick<
  ListTemplate,
  'itemStateMode' | 'featureConfig' | 'slot' | 'icon' | 'emptyStateCopy'
>;

/**
 * Computed once at module load and frozen, as the chooser projection is: the catalogue is a
 * shipped constant, so a lookup over it is one too.
 */
const SEEDS: ReadonlyMap<string, ListTemplateSeed> = new Map(
  LIST_TEMPLATES.map((template) => [
    template.templateKey,
    Object.freeze({
      itemStateMode: Object.freeze({ ...template.itemStateMode }),
      featureConfig: Object.freeze({ ...template.featureConfig }),
      slot: template.slot,
      icon: template.icon,
      emptyStateCopy: template.emptyStateCopy,
    }),
  ]),
);

/** The values a create copies for `templateKey`, or `undefined` if no such style exists. */
export function listTemplateSeed(templateKey: string): ListTemplateSeed | undefined {
  return SEEDS.get(templateKey);
}
