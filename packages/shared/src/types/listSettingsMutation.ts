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
 * The token pair is optional, and its absence carries meaning. A rename has no undo row in
 * `interaction-contract.md` §4.1, a patch that changes nothing has nothing to take back, and
 * a behaviour **downgrade** is confirmed rather than undone — its only path back is a fresh
 * `?confirmDataLoss=true` call, so offering Undo would promise a restore the server cannot
 * make. A client offers Undo exactly when both fields are present.
 *
 * `undoExpiresAt` is the presentation deadline on the same terms as
 * {@link ReversibleItemMutation}: stop offering at that instant, while an inverse the user
 * already accepted stays valid for `MAX_AUTOMATIC_INTENT_AGE_DAYS`.
 */
export interface ListSettingsMutation {
  list: ListView;
  undoToken?: string;
  undoExpiresAt?: string;
}
