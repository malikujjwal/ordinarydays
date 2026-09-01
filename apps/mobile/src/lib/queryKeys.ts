/**
 * Query-key roots that more than one feature needs.
 *
 * ## Why this is not in a feature
 *
 * A key belongs in its feature's hooks — `healthKey` in `features/health` — and
 * `repo-structure.md` §7 says so. The ones here have no single owner:
 * `features/plans` **reads** the activity lists and `features/compose` **writes** to them, so
 * whichever feature held the root, the other would have to reach across for it, and
 * `check-forbidden`'s `client-layer-rules` bans exactly that import (rightly — a feature
 * importing another feature's internals is how slices stop being slices).
 *
 * A neutral module both may import is the fix, and it is the same shape `lib/apiClient.ts` and
 * `lib/queryClient.ts` already have. The alternative — spelling `['activities', …]` in both
 * places — is the "never inline strings" rule broken twice, and the failure mode is silent:
 * the writer invalidates a key the reader is not using and the list simply never updates.
 * That is not hypothetical. It is the bug P1-29's E2E flow found (a saved activity that never
 * appeared in Plans), and this module exists so the fix cannot drift back apart.
 */

/**
 * The root of every activity-list key. `usePlans` extends it with a filter; a writer
 * invalidates the root and so refreshes every stage at once, which is right — a new activity
 * can land in any of them and the writer does not know which.
 */
export const ACTIVITIES_KEY = ['activities'] as const;

/**
 * One activity's detail read.
 *
 * Moved here from `features/activity/hooks/useActivity` when `lib/agendaCache` needed it: a
 * completion recorded on any surface has to update the detail cache, or the detail screen goes
 * on claiming an activity is completed for the length of its stale time after the row has
 * gone back to normal.
 *
 * It moved rather than being imported from the hook because a **key is not a hook**. Importing
 * the hook module for it dragged `expo-crypto` into every consumer, which fails outright in a
 * unit test with no native module — the import graph telling us the key was in the wrong
 * place.
 */
export const activityKey = (activityId: string) => ['activity', activityId] as const;

/**
 * The root of every Lists query.
 *
 * Moved here from `features/lists/hooks/keys.ts` when P3-34 gave it a second owner: the
 * `Plan this item` bridge writes a caller-scoped `viewerLink` onto a list item from
 * `features/compose`, and the reader is `features/lists`. The reasoning in this module's
 * header applies verbatim — a writer invalidating a key the reader is not using fails
 * silently, so both import the one literal.
 */
export const LISTS_KEY = ['lists'] as const;

/** One authoritative detail projection; occurrence reads never alias the series cache. */
export const activityDetailKey = (
  target:
    | { readonly kind: 'activity'; readonly activityId: string }
    | { readonly kind: 'occurrence'; readonly activityId: string; readonly date: string },
) =>
  target.kind === 'activity'
    ? activityKey(target.activityId)
    : (['activity', target.activityId, 'occurrence', target.date] as const);
