/**
 * Query-key roots that more than one feature needs.
 *
 * ## Why this is not in a feature
 *
 * A key belongs in its feature's hooks — `activityKey` in `features/activity`, `healthKey` in
 * `features/health` — and `repo-structure.md` §7 says so. This one has no single owner:
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
