import type { CreationTarget } from '@od/shared/client';
import type { CreateActivityInput } from '@od/shared/schemas';
import { planKindChoices, planKindLabel } from '@/lib/planKinds';

/**
 * The chooser's vocabulary, and the mapping from a chosen target onto a request body
 * (`activities.md` §2.2, §2.5, `interaction-contract.md` §1a.3).
 *
 * Pure: no React, no store, no network. Everything here is a total function of an explicit
 * choice, which is what lets the whole of `CLAUDE.md` rule 2 be asserted without rendering
 * anything.
 *
 * ## What is deliberately absent
 *
 * There is no `inferTarget`, no `defaultTarget`, no `suggestPlanKind`, and no function that
 * takes a title. **Nothing in this module accepts free text.** A helper that mapped words to
 * a kind would be the single change that breaks the product, and the way to keep it from
 * being written by accident is for the module that would host it to have no input to offer.
 */

/** The three rows of the global chooser, in their fixed order. Never reordered by history. */
export type ObjectChoice = 'task' | 'plan' | 'listItem';

export interface Choice<T> {
  value: T;
  label: string;
}

/**
 * `Task`, `Plan`, `List item` — exactly these labels, exactly this order.
 *
 * Frozen so that a caller cannot sort or splice it. The chooser "does not remember, reorder
 * or pre-select the last target"; a mutable module-level array is how the first
 * most-recently-used experiment would get written.
 */
export const objectChoices: readonly Choice<ObjectChoice>[] = Object.freeze([
  { value: 'task', label: 'Task' },
  { value: 'plan', label: 'Plan' },
  { value: 'listItem', label: 'List item' },
]);

/**
 * `General`, `Meal`, `Watch`, `Event`, `Outing`, in order.
 *
 * Re-exported from `@/lib/planKinds` rather than defined here: the detail screen renders the
 * same labels, and a second feature importing this module is exactly what
 * `no-cross-feature-imports` forbids. The reasoning for the move is written out there.
 */
export { planKindChoices, planKindLabel };

/**
 * The header that stays visible on the form: `Task`, or `Plan · Watch`.
 *
 * It is not a suggestion banner and it is not dismissible — the selected object and Plan kind
 * remain visible while the form is filled (`activities.md` §2.4).
 */
export function targetHeading(target: CreationTarget): string {
  if (target.objectKind === 'task') return 'Task';
  if (target.objectKind === 'plan') return `Plan · ${planKindLabel(target.type)}`;
  return 'List item';
}

/**
 * The final button's label. **It names the exact write** (`activities.md` §2.5).
 *
 * A generic `Save` is a defect here, not a simplification: the button is the last moment at
 * which the user can see what is about to be written and where.
 */
export function saveLabel(target: CreationTarget, listName?: string): string {
  if (target.objectKind === 'task') return 'Save task';
  if (target.objectKind === 'plan') return 'Save plan';
  return `Add to ${listName ?? 'list'}`;
}

/**
 * The draft fields that survive a target change.
 *
 * Only the fields common to every type in `activities.md` §4 — which in Phase 1 is all of
 * them, because P1-24 collects title, notes and a source URL and nothing type-specific. The
 * shape is named rather than inlined because **P1-17's field mapping plugs in exactly here**
 * when the forms in P1-25 add type-specific fields, and having the seam already carved is
 * what stops that landing as a rewrite of the store.
 */
export interface CommonDraftFields {
  title: string;
  notes: string;
  sourceUrl?: string;
}

/**
 * Builds the create request from a fixed target plus the common fields.
 *
 * `target` is a required parameter of a union type, so there is no reachable call that omits
 * `objectKind` or `type` — the compiler refuses it before the server ever has to. The
 * `listItem` arm returns `undefined` because a List item is not an Activity and does not go
 * to `POST /v1/activities` at all; Phase 3 gives it `POST /v1/lists/:id/items`.
 */
export function toCreateActivityInput(
  target: CreationTarget,
  fields: CommonDraftFields,
): CreateActivityInput | undefined {
  const title = fields.title.trim();
  const notes = fields.notes.trim();

  const common = {
    title,
    ...(notes === '' ? {} : { notes }),
    ...(fields.sourceUrl === undefined || fields.sourceUrl === ''
      ? {}
      : { sourceUrl: fields.sourceUrl }),
  };

  if (target.objectKind === 'task') {
    return { ...common, objectKind: 'task', type: 'task', details: { kind: 'task' } };
  }

  if (target.objectKind === 'plan') {
    return {
      ...common,
      objectKind: 'plan',
      type: target.type,
      /**
       * `details` mirrors the chosen type so the server's `details.kind === type` check has
       * something to agree with. Watch is the one arm with a required sub-field — its
       * `mediaTitle` starts equal to the title, per `activities.md` §4.3.
       */
      details:
        target.type === 'watch'
          ? { kind: 'watch', mediaTitle: title }
          : target.type === 'outing'
            ? { kind: 'outing', placeName: title }
            : { kind: target.type },
    };
  }

  return undefined;
}

/**
 * Whether the named write action is available (`activities.md` §2.5).
 *
 * A non-empty trimmed title, and nothing else. There is no second required field on any
 * target, because object and Plan kind were already answered before this form opened — which
 * is the whole reason the explicit chooser costs the user nothing.
 */
export function canSave(fields: CommonDraftFields): boolean {
  return fields.title.trim() !== '';
}

/**
 * The success toast (`activities.md` §2.5).
 *
 * Phase 1 creates nothing dated — the date picker is P1-25 — so only the undated rows of that
 * table are reachable and only they are implemented. The dated rows arrive with the control
 * that can produce them; writing them now would mean untestable copy.
 */
export function successToast(target: CreationTarget): string {
  if (target.objectKind === 'task') return 'Task · saved to Anytime';
  if (target.objectKind === 'plan') {
    return `${planKindLabel(target.type)} plan · saved to Needs a date`;
  }
  return 'Added to list';
}
