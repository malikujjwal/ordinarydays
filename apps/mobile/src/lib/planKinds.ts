import type { PlanType } from '@od/shared/types';

/**
 * The five Plan kinds and the words the user sees for them (`activities.md` §2.2).
 *
 * ## Why this is in `lib/` and not in a feature
 *
 * Two features need it — the chooser in `compose` picks a kind, the detail screen in
 * `activity` renders the one that was picked — and `dependency-cruiser`'s
 * `no-cross-feature-imports` rule exists to stop the second reaching into the first. A
 * feature that another feature imports from is not a feature; it is shared code that has not
 * been moved yet.
 *
 * ## Why not `packages/shared`
 *
 * `custom` is the stored type and `General` is what a person reads. That mapping is **client
 * copy**, not contract: the API never renders the word `General`, never receives it, and
 * would not change if the product renamed it tomorrow. `packages/shared` holds the shapes
 * both sides must agree on, and putting UI strings there would make a copy change a
 * cross-package release.
 *
 * ## The rule the order encodes
 *
 * `General` is **first and is a real, visible choice** — never the value used when nothing
 * was selected. The array is frozen so a caller cannot sort it into a most-recently-used
 * order, which is the first thing that would quietly break `CLAUDE.md` rule 2.
 */
export interface PlanKindChoice {
  value: PlanType;
  label: string;
}

export const planKindChoices: readonly PlanKindChoice[] = Object.freeze([
  { value: 'custom', label: 'General' },
  { value: 'meal', label: 'Meal' },
  { value: 'watch', label: 'Watch' },
  { value: 'event', label: 'Event' },
  { value: 'outing', label: 'Outing' },
]);

const labels = new Map(planKindChoices.map((c) => [c.value, c.label]));

/** The Plan kind's user-facing word. `custom` reads `General` everywhere, never `Custom`. */
export function planKindLabel(type: PlanType): string {
  const label = labels.get(type);
  if (label === undefined) throw new Error(`Unknown plan kind: ${type as string}`);
  return label;
}
