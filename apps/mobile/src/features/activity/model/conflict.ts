import type { PatchActivityInput } from '@od/shared/schemas';
import type { Activity } from '@od/shared/types';

/**
 * What to do with a pending edit after a `409 conflict` (`activities.md` §6.1).
 *
 * > A `409 conflict` means someone else changed the plan; the client refetches, shows
 * > `This plan changed. Review the update.` and re-applies the user's pending edit onto the
 * > fresh version **only if the fields do not overlap**. Overlapping fields are dropped and
 * > the user is told which.
 *
 * Pure and separate from the hook, because this is the rule that is easy to get subtly wrong
 * and impossible to exercise by hand: producing a real 409 needs two clients editing the same
 * activity inside the same second.
 *
 * ## What "overlap" means, precisely
 *
 * A field overlaps when **the other person changed it too** — not merely when the local edit
 * touches it. Comparing the pending edit against the field's value in the *fresh* activity is
 * not enough either: if they set the title to exactly what you were setting it to, there is
 * nothing to drop and nothing to tell you about.
 *
 * So the comparison is three-way, and it needs the value the local edit started from:
 *
 * - `base` — the activity as the client last saw it, which is what `If-Match` was built from.
 * - `fresh` — what the server has now.
 * - `pending` — the fields the user changed locally.
 *
 * A field is **theirs** when `fresh[f] !== base[f]`. A pending change to a field that is
 * theirs is dropped and named; every other pending field is re-applied against `fresh`'s
 * `updatedAt`. Without `base` the merge would drop edits nobody else had made, which is the
 * bug this shape exists to prevent.
 */

/** The fields a client may patch from the detail screen. */
const MERGEABLE_FIELDS = ['title', 'notes', 'details', 'sourceUrl'] as const;

type MergeableField = (typeof MERGEABLE_FIELDS)[number];

/** The label the user sees, never the stored path (`interaction-contract.md` §1a.1 rule 4). */
const FIELD_LABELS: Record<MergeableField, string> = {
  title: 'Title',
  notes: 'Notes',
  details: 'Details',
  sourceUrl: 'Link',
};

export interface ConflictResolution {
  /** The subset of the pending edit that is safe to re-apply, or `undefined` if none is. */
  reapply: PatchActivityInput | undefined;
  /** User-facing labels of the fields that were dropped, in the order they are declared. */
  dropped: string[];
  /** The version to send with the re-applied edit. */
  ifMatch: string;
}

function differs(a: unknown, b: unknown): boolean {
  return canonicalJson(a) !== canonicalJson(b);
}

/**
 * Structural comparison for mergeable fields. `details` is an object: a refetch always
 * produces a new reference, so `!==` would classify every details edit as theirs and drop
 * it. Key order is sorted; `null` and `undefined` are the same absence.
 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value)) ?? 'null';
}

function normalize(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === 'object') {
    const input = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) {
      const inner = input[key];
      if (inner === undefined) continue;
      out[key] = normalize(inner);
    }
    return out;
  }
  return value;
}

export function resolveConflict(
  base: Activity,
  fresh: Activity,
  pending: PatchActivityInput,
): ConflictResolution {
  const reapply: Record<string, unknown> = {};
  const dropped: string[] = [];

  for (const field of MERGEABLE_FIELDS) {
    if (!(field in pending)) continue;

    const theirs = differs(fresh[field], base[field]);
    if (!theirs) {
      reapply[field] = pending[field];
      continue;
    }

    /**
     * They changed it too — but to the same thing. There is nothing to drop and nothing
     * worth interrupting the user about, so it is simply satisfied and not re-sent.
     */
    if (!differs(fresh[field], pending[field])) continue;

    dropped.push(FIELD_LABELS[field]);
  }

  return {
    reapply:
      Object.keys(reapply).length === 0 ? undefined : (reapply as PatchActivityInput),
    dropped,
    ifMatch: fresh.updatedAt,
  };
}

/** `This plan changed. Review the update.` — §6.1's copy, verbatim, on every conflict. */
export const CONFLICT_MESSAGE = 'This plan changed. Review the update.';

/**
 * The follow-on line naming what was dropped, or `undefined` when nothing was.
 *
 * Separate from {@link CONFLICT_MESSAGE} because the two are different promises: the first
 * always appears, the second only when the user actually lost something they typed.
 */
export function droppedMessage(dropped: string[]): string | undefined {
  if (dropped.length === 0) return undefined;
  const list =
    dropped.length === 1
      ? dropped[0]
      : `${dropped.slice(0, -1).join(', ')} and ${dropped[dropped.length - 1]}`;
  return `Your change to ${list} was not applied.`;
}
