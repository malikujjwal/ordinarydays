import { ApiError, getActivity, type HttpClient } from '@od/shared/client';
import type { ActivityDetail } from '@od/shared/types';

/**
 * What to do when a create came back saying its id is unavailable (P2-49, founder decision 3).
 *
 * The server answers a taken or tombstoned id with one generic `conflict` that names neither
 * owner nor entity, so the error alone cannot say what happened. The client resolves it by
 * reading **its own id** — the one case where a read is unambiguous, because a `200` the
 * caller is authorised to see can only be their own earlier write.
 *
 * **It never re-mints automatically.** A fresh id would sail past the tombstone that caused
 * the collision and resurrect something the user deleted on another device, which is the one
 * outcome this whole mechanism exists to prevent. Re-minting is a user's explicit retry
 * (`interaction-contract.md` §5.4) and nothing else.
 */
export type CollisionOutcome =
  | { kind: 'acknowledged'; detail: ActivityDetail }
  | { kind: 'needs_confirmation' };

/**
 * Resolves a collision by reading the id the client minted.
 *
 * - `200` — the earlier create landed and the response was lost. Acknowledge on **identity
 *   and ownership alone**: the read succeeded, so the caller owns it, and that is the whole
 *   test. No field comparison, deliberately — the server entity wins wholesale, and
 *   comparing titles or schedules would resurrect the reconciliation pipeline that
 *   client-minted ids exist to delete.
 * - `404` — either a foreign id collided, or this id was created and then deleted elsewhere
 *   and is now tombstoned. Indistinguishable by design, and both need the same thing: the
 *   user decides. Surfaced, never retried on its own.
 *
 * Any other failure is transport trouble rather than an answer, so it propagates and the
 * intent stays queued for the next attempt.
 */
export async function recoverFromCollision(
  client: HttpClient,
  activityId: string,
): Promise<CollisionOutcome> {
  try {
    const detail = await getActivity(client, { kind: 'activity', activityId });
    return { kind: 'acknowledged', detail };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return { kind: 'needs_confirmation' };
    }
    throw error;
  }
}
