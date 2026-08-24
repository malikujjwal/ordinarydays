/**
 * What `POST /v1/lists/:id/undo` returns (`api-contract.md` §2.7, P3-10).
 *
 * Three outcomes, discriminated, all of them `200`. The route was asked to apply a recorded
 * compensation and answers with what happened to it — none of the three is a failed request,
 * which is why no `ErrorCode` was added for the last two.
 *
 * `expired` covers an unknown token, a hash mismatch and a retention-expired operation
 * without distinguishing them: telling a caller their token is well-formed but expired,
 * rather than simply unknown, would tell them something about an operation they may not own.
 *
 * `no_longer_applicable` is the opposite case — the operation is retained and the token is
 * right, but it has already been used, or a settings inverse's recorded preconditions no
 * longer hold because somebody edited what it would put back. Nothing is written for either.
 */
export type ListUndoResult =
  | { outcome: 'applied'; affectedCount: number }
  | { outcome: 'expired' }
  | { outcome: 'no_longer_applicable' };
