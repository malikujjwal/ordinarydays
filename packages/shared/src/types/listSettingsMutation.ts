import type { ListView } from './listView.js';

/**
 * What an additive list-settings mutation returns — `PATCH /v1/lists/:id` and the upgrade
 * direction of `POST /v1/lists/:id/behaviour` (`api-contract.md` §2.7, P3-09).
 *
 * The list is the **whole new row**, not a diff: a settings change is a single conditional
 * write and the client replaces what it holds rather than merging two representations. It is
 * the `ListView` projection, so the two storage-only work markers are absent here exactly as
 * they are everywhere else a List reaches a client.
 *
 * **Two shapes, not one with optional fields.** An Undo offer is a token *and* the deadline
 * it is offered until, so a client either has both or has none — there is no state in which
 * one is meaningful alone, and a type that admitted one would invite a caller to read a token
 * it cannot time.
 *
 * The offer's absence carries meaning. A rename has no undo row in
 * `interaction-contract.md` §4.1, a patch that changes nothing has nothing to take back, and
 * a behaviour change that **lost** data was confirmed rather than offered — returning needs
 * another preview-and-confirm action. A change that lost nothing, in either direction, is an
 * ordinary additive settings change and does carry an offer.
 *
 * `undoExpiresAt` is the presentation deadline on the same terms as
 * {@link ReversibleItemMutation}: stop offering at that instant, while an inverse the user
 * already accepted stays valid for `MAX_AUTOMATIC_INTENT_AGE_DAYS`.
 */
export type ListSettingsMutation =
  | { list: ListView }
  | { list: ListView; undoToken: string; undoExpiresAt: string };
