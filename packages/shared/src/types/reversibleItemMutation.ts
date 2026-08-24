/**
 * What a reversible item mutation returns — single delete now, and `clear-checked` /
 * `uncheck-all` when P3-10 adds them (`api-contract.md` §2.7).
 *
 * `undoExpiresAt` is the client's **presentation deadline**: the UI stops offering Undo at
 * that instant. It is not the server's replay deadline — an inverse the user already
 * accepted remains valid for `MAX_AUTOMATIC_INTENT_AGE_DAYS`, so an Undo accepted offline
 * cannot expire in transit.
 *
 * `undoToken` is opaque. Only its hash is stored, and the client hands it back to
 * `POST /v1/lists/:id/undo` (P3-10) rather than sending deleted row contents as authority.
 */
export interface ReversibleItemMutation {
  affectedCount: number;
  undoToken: string;
  undoExpiresAt: string;
}
