import type { ListCapabilities, ListTemplate } from '../types/list.js';
import { listCapabilities } from './ingredientDestination.js';
import { LIST_TEMPLATES } from './templates.js';

/**
 * The explicit template/style selection contract (`phase-03` §P3-07, ADR-032).
 *
 * What the creation sheet renders **before** the user names the list: every catalogue record,
 * exactly once, in the catalogue's own fixed order, projected to the fields a chooser needs
 * to display and to apply a write-capability constraint. Nothing is selected, recommended,
 * pinned, reordered or hidden.
 *
 * ## What this module deliberately is not
 *
 * It is a **field projection and nothing else** — no per-template map, no switch, no second
 * ordering array, no copy of its own. Every visible string already lives on the catalogue
 * record (P3-02), so adding "Books to read" stays one entry in one array; a label duplicated
 * here would be a second place to edit and a second place to get wrong.
 *
 * It accepts **no title and no free text**, and returns no recommendation, ranking, score or
 * fallback. The user's tap on a visible style is the only input that sets `templateKey`, and
 * the title typed on the next step cannot change it (`plans-and-lists.md` §5.4,
 * `interaction-contract.md` §2). There is no `suggest-template` route, matcher, match-term
 * array, fuzzy search or model call anywhere in the product, and
 * `scripts/check-forbidden.mjs no-template-suggester` fails the build if one appears.
 *
 * ## Why a bundled projection rather than a fetch
 *
 * The mobile sheet renders this, not `GET /v1/list-templates` (P3-06). Both read the same
 * shared module, so every client gets the same order and the same labels without a second
 * catalogue and without a startup request — which is what makes creating a list work on a
 * first launch with no network.
 */

/**
 * One chooser row. Derived with `Pick`, never re-declared: a field that changes type on
 * `ListTemplate` changes here too, and a field that is removed stops compiling.
 *
 * `chooserLabel` and `defaultTitle` are **two different fields, deliberately** — `Blank` is
 * the style you tap, `Simple list` is the editable title it prefills.
 *
 * It lives beside the projection rather than in `types/`: it is this function's return shape,
 * not a stored entity or a wire shape, and it has no schema because nothing serialises it.
 */
export type ListTemplateChoice = Pick<
  ListTemplate,
  'templateKey' | 'chooserLabel' | 'icon' | 'summary' | 'defaultTitle' | 'itemStateMode'
> & {
  /**
   * The same derivation the API guard and a stored List's response field use
   * (`listCapabilities`, `ingredientDestination.ts`) — computed here, not filtered here.
   * A caller that needs only capable templates filters this array itself; nothing in this
   * module chooses or hides a style.
   */
  capabilities: ListCapabilities;
};

/**
 * Computed once at module load and frozen: the catalogue is a shipped constant, so its
 * projection is one too, and a caller cannot reorder the array it was handed.
 */
const CHOICES: readonly ListTemplateChoice[] = Object.freeze(
  LIST_TEMPLATES.map((template) =>
    Object.freeze({
      templateKey: template.templateKey,
      chooserLabel: template.chooserLabel,
      icon: template.icon,
      summary: template.summary,
      defaultTitle: template.defaultTitle,
      itemStateMode: template.itemStateMode,
      capabilities: listCapabilities(template),
    }),
  ),
);

/**
 * Every style the user may choose, in catalogue order.
 *
 * **Takes no arguments**, and that is the contract rather than an oversight: a parameter is
 * how a title, a Plan kind or a "recent" hint would get in, and any of those would let
 * something other than the user's tap decide what they are making.
 */
export function listTemplateChoices(): readonly ListTemplateChoice[] {
  return CHOICES;
}
