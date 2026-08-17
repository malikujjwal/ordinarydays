import type { PlanType } from '@od/shared/types';

/**
 * The four Plan kinds and the words the user sees for them (`activities.md` §2.2).
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
  /**
   * One line saying what the kind is for (founder, 2026-08-16: *"I need subtexts on these
   * screens, so that the user can tell what the option is for"*).
   *
   * Taken from §1.1's **"Guides creation of"** column rather than written fresh, so the chooser
   * and the table that defines the kinds say the same thing. Event's is abridged — §1.1 lists
   * seven examples, which is a paragraph rather than a row subtitle.
   */
  subtitle: string;
}

export const planKindChoices: readonly PlanKindChoice[] = Object.freeze([
  {
    value: 'custom',
    label: 'General',
    subtitle: 'A plan that does not fit the guided kinds',
  },
  { value: 'meal', label: 'Meal', subtitle: 'Something to eat or cook' },
  { value: 'watch', label: 'Watch', subtitle: 'A movie, show, or episode' },
  {
    value: 'event',
    label: 'Event',
    subtitle: 'A concert, appointment, restaurant, or trip',
  },
]);

const labels = new Map(planKindChoices.map((c) => [c.value, c.label]));

/** The Plan kind's user-facing word. `custom` reads `General` everywhere, never `Custom`. */
export function planKindLabel(type: PlanType): string {
  const label = labels.get(type);
  if (label === undefined) throw new Error(`Unknown plan kind: ${type as string}`);
  return label;
}
