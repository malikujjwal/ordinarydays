import type { Instant } from '../time/types.js';
import type { ListView } from './listView.js';

/**
 * What an immediate list-settings mutation returns from `PATCH /v1/lists/:id`.
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
 * The offer's absence means the patch changed nothing. Every effective setting — including
 * a rename, state presentation, feature configuration, slot and archive — applies immediately
 * and carries the same six-second Undo offer.
 *
 * `undoExpiresAt` is the presentation deadline on the same terms as
 * {@link ReversibleItemMutation}: stop offering at that instant, while an inverse the user
 * already accepted stays valid for `MAX_AUTOMATIC_INTENT_AGE_DAYS`.
 */
export type ListSettingsMutation =
  | { list: ListView }
  | { list: ListView; undoToken: string; undoExpiresAt: Instant };
